"""Extract source evidence in parallel, validate placement, then apply graph edits serially."""
import asyncio
import hashlib
import re
import json
from pathlib import Path
from app.embeddings import text_hash
from app.agents.concept_addition import ConceptAdditionAgent
from app.llm.base import LLMError
from app.models.chat import ChatAssessment, ChatExtraction, ChatPlanReview, ChatStructurePlan, ChatRoutingRecord, ExtractionInput, StoredExperience, ChatObservation, Citation
from app.models.domain import AdditionInput, uid
from app.policies.conversation import PROVISIONAL_CREATION_REASON, PROVISIONAL_CREATION_SCORE
from app.services.diagnostic import find, spec, walk
from app.services.chat_retrieval import ChatRetrieval, unit_order


def split_text(text, limit):
    """Lossless source slices with natural boundaries and inherited Markdown headings."""
    chunks, start, headings = [], 0, []
    while start < len(text):
        end = min(start + limit, len(text))
        if end < len(text):
            segment = text[start:end]
            for boundary in ('\n\n', '\n', '。', '. ', ' '):
                cut = segment.rfind(boundary)
                if cut >= limit // 2:
                    end = start + cut + len(boundary)
                    break
        source = text[start:end]
        section = list(headings)
        for match in re.finditer(r'^\s{0,3}(#{1,6})\s+(.+)$', source, re.MULTILINE):
            depth, title = len(match[1]), match[2].strip()
            headings = headings[:depth-1] + [title]
        chunks.append((source, section))
        start = end
    return chunks


def addition_key(addition):
    return hashlib.sha256(addition.model_dump_json().encode()).hexdigest()[:24]


class ChatMapProcessor:
    def __init__(self, chat):
        self.chat, self.repo, self.diagnostic, self.settings = chat, chat.repo, chat.diagnostic, chat.settings
        self.retrieval = ChatRetrieval(chat)

    def progress(self, session_id, turn_id, phase=None, **values):
        def update(session):
            job = next(item for item in session.chat.jobs if item.turn_id == turn_id)
            if phase and job.status != 'complete':
                job.phase = phase
            for key, value in values.items():
                setattr(job, key, value)
        return self.chat.mutate(session_id, update)

    async def parallel(self, jobs):
        results = await asyncio.gather(*jobs, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        return results

    async def extract(self, session_id, turn_id):
        session = self.repo.get(session_id)
        message = next(item for item in session.chat.messages if item.message_id == turn_id)
        chunks = split_text(message.content, self.settings.chat_chunk_chars)
        self.progress(session_id, turn_id, 'extracting', total_chunks=len(chunks))
        completed = next(job for job in session.chat.jobs if job.turn_id == turn_id).completed_chunks
        async def one(index, source, section):
            payload = ExtractionInput(theme=session.theme, domain_context=session.domain_context,
                                      message_id=turn_id, text=source, section=section)
            result = await self.chat.generate(session_id, turn_id, 'chat_extract', payload, ChatExtraction)
            units = []
            for order, unit in enumerate(result.units):
                if not self.chat.valid_citations(unit.citations, [message]) or any(
                        ref.message_id != turn_id or ref.quote not in source for ref in unit.citations):
                    continue
                identity = unit.model_dump_json(exclude={'granularity', 'parent_topic'})
                key = hashlib.sha256((turn_id + identity).encode()).hexdigest()[:24]
                units.append(StoredExperience(**unit.model_dump(), unit_id='unit_'+key, turn_id=turn_id, source_chunk=index, source_order=order))
            def save(current):
                known = {unit.unit_id for unit in current.chat.experience_units}
                for unit in units:
                    if unit.unit_id not in known:
                        current.chat.experience_units.append(unit)
                        known.add(unit.unit_id)
                job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
                job.completed_chunks = sorted(set([*job.completed_chunks, index]))
            self.chat.mutate(session_id, save)
        outcomes = await asyncio.gather(*(one(index, source, section) for index, (source, section) in enumerate(chunks)
            if index not in completed), return_exceptions=True)
        errors = [str(result) for result in outcomes if isinstance(result, BaseException)]
        if errors:
            self.defer(session_id, turn_id, ['文章の一部の抽出を再試行します。'])
        self.chat.evidence_queue.ensure(session_id)
        return [unit for unit in self.repo.get(session_id).chat.experience_units if unit.turn_id == turn_id]

    def planning_context(self, session, turn_id, units, candidates=None, documents=None):
        if candidates is None:
            candidates = {unit.unit_id: [item['concept_id'] for item in self.chat.concepts(
                session, unit.topic+' '+unit.statement, selected='', prioritize_focus=False)] for unit in units}
        documents = documents or self.retrieval.documents(session)
        related, per_unit = set(), {}
        for unit in units:
            allowed = {session.knowledge_tree.concept_id}
            for identifier in candidates.get(unit.unit_id, []):
                document = documents.get(identifier)
                node = find(session, document['parent_id']) if document and document['prepared'] else find(session, identifier)
                if document and document['prepared']:
                    allowed.add(identifier)
                seen = set()
                while node and node.concept_id not in seen:
                    seen.add(node.concept_id)
                    related.add(node.concept_id)
                    allowed.add(node.concept_id)
                    allowed.update(child.concept_id for child in node.child_nodes)
                    allowed.update(edge.target for edge in session.concept_edges
                                   if edge.source == node.concept_id and edge.relation == 'part')
                    allowed.update(key for key, item in documents.items()
                                   if item['prepared'] and item['parent_id'] == node.concept_id)
                    node = find(session, node.parent_concept_id) if node.parent_concept_id else None
            per_unit[unit.unit_id] = sorted(allowed)
        nodes = self.chat.concepts(session, '', only_ids=related)
        nodes.insert(0, {**spec(session.knowledge_tree).model_dump(), 'depth': 0,
                         'path': [session.theme], 'has_children': bool(session.knowledge_tree.child_nodes)})
        context = self.chat.evidence_input(session, turn_id, units, concepts=nodes, purpose='structure')
        context.unit_concept_ids = per_unit
        for item in context.concepts:
            node = find(session, item['concept_id'])
            item['parent_concept_id'] = node.parent_concept_id
            linked = [find(session, edge.target) for edge in session.concept_edges
                      if edge.source == node.concept_id and edge.relation == 'part']
            children = {child.concept_id: child for child in [*node.child_nodes, *linked] if child}
            item['existing_children'] = [spec(child).model_dump() for child in children.values()]
            item['prepared_children'] = [document['concept'].model_dump() for document in documents.values()
                if document['prepared'] and document['parent_id'] == node.concept_id]
            item['can_expand'] = self.diagnostic.can_expand(session, node)
        return context

    def fail_units(self, session_id, turn_id, units, error, stage='routing'):
        identifiers = {unit.unit_id for unit in units}
        def save(current):
            job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
            job.failed_unit_ids = sorted(set(job.failed_unit_ids) | identifiers)
            for item in current.chat.evidence_queue:
                if item.unit_id in identifiers:
                    item.processing_error = str(error)[:600]
                    item.failed_stage = stage
        self.chat.mutate(session_id, save)

    def clear_units(self, session_id, turn_id, units, stage='routing'):
        identifiers = {unit.unit_id for unit in units}
        def save(current):
            job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
            cleared = set()
            for item in current.chat.evidence_queue:
                if item.unit_id in identifiers and item.failed_stage in (None, stage):
                    item.processing_error = None
                    item.failed_stage = None
                    cleared.add(item.unit_id)
            job.failed_unit_ids = [identifier for identifier in job.failed_unit_ids if identifier not in cleared]
            if (job.status == 'failed' and job.planning_complete and not job.failed_unit_ids and len(job.completed_chunks) == job.total_chunks
                    and job.error == 'マップの一部を反映できませんでした。保存済みの更新から再試行できます。'):
                job.status, job.phase, job.error = 'complete', 'complete', None
        self.chat.mutate(session_id, save)

    async def plan(self, session_id, turn_id, units):
        job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
        if job.planning_complete:
            self.chat.evidence_queue.record_links(session_id, units, job.planned_links)
            return job.planned_expansions, job.planned_additions, set(job.related_concept_ids)
        self.progress(session_id, turn_id, 'planning')
        plan = await self.route(session_id, turn_id, units,
                                allow_additions=not bool(self.diagnostic.generation_tasks(session_id)))
        linked = {link.concept_id for link in plan.links}
        self.progress(session_id, turn_id, planning_complete=True, planned_expansions=plan.expand_concept_ids,
                      planned_additions=plan.additions, planned_links=plan.links, related_concept_ids=sorted(linked))
        self.chat.evidence_queue.record_links(session_id, units, plan.links)
        return plan.expand_concept_ids, plan.additions, linked

    async def route(self, session_id, turn_id, units, reconciliation=False, allow_additions=True):
        session = self.repo.get(session_id)
        indexed_graph = self.chat.evidence_queue.fingerprint(session)
        documents, candidates = await self.retrieval.search(session, units)
        eligible = []
        for unit in units:
            if isinstance(candidates[unit.unit_id], BaseException):
                self.fail_units(session_id, turn_id, [unit], candidates[unit.unit_id])
            else:
                eligible.append(unit)
        async def one(batch, individual_retry=False):
            local_documents, local_candidates = documents, dict(candidates)
            local_graph = indexed_graph
            for attempt in range(3):
                latest = self.repo.get(session_id)
                graph = self.chat.evidence_queue.fingerprint(latest)
                if graph != local_graph:
                    local_documents, refreshed = await self.retrieval.search(latest, batch)
                    local_candidates.update(refreshed)
                    local_graph = graph
                    if graph != self.chat.evidence_queue.fingerprint(self.repo.get(session_id)):
                        continue
                available = []
                for unit in batch:
                    if isinstance(local_candidates[unit.unit_id], BaseException):
                        self.fail_units(session_id, turn_id, [unit], local_candidates[unit.unit_id])
                    else:
                        available.append(unit)
                batch = available
                if not batch:
                    return []
                context = self.planning_context(latest, turn_id, batch, local_candidates, local_documents)
                context.reconciliation, context.allow_additions = reconciliation, allow_additions
                # Hash each unit's own context so changing batch membership does not invalidate it.
                hashes = {}
                for unit in batch:
                    single = self.planning_context(latest, turn_id, [unit], local_candidates, local_documents)
                    single.reconciliation, single.allow_additions = reconciliation, allow_additions
                    hashes[unit.unit_id] = self.retrieval.context_hash(single)
                cached, fresh = [], []
                for unit in batch:
                    record = latest.chat.routing_records.get(f'{unit.unit_id}:{reconciliation}:{allow_additions}')
                    if record and record.context_hash == hashes[unit.unit_id]:
                        cached.append(record.plan)
                    else:
                        fresh.append(unit)
                if not fresh:
                    return cached
                context = self.planning_context(latest, turn_id, fresh, local_candidates, local_documents)
                context.reconciliation, context.allow_additions = reconciliation, allow_additions
                try:
                    proposed = await self.chat.generate(session_id, turn_id, 'chat_structure', context, ChatStructurePlan)
                    prepared_parents = {child['concept_id']: node['concept_id'] for node in context.concepts
                                        for child in node.get('prepared_children', [])}
                    sources = {unit.unit_id: unit for unit in fresh}
                    links, invalid = [], set()
                    for link in proposed.links:
                        if link.unit_id not in sources:
                            continue
                        if link.concept_id not in context.unit_concept_ids[link.unit_id]:
                            invalid.add(link.unit_id)
                            continue
                        if link.concept_id in prepared_parents:
                            link = link.model_copy(update={'concept_id': prepared_parents[link.concept_id], 'needs_detail': True})
                        if find(latest, link.concept_id):
                            links.append(link)
                    linked = {link.concept_id for link in links}
                    requested = list(dict.fromkeys([*proposed.expand_concept_ids,
                        *(link.concept_id for link in links if link.needs_detail),
                        *(link.concept_id for link in links if any(node['concept_id'] == link.concept_id
                            and node.get('can_expand') and node['granularity'] in ('broad', 'medium')
                            for node in context.concepts))]))
                    if reconciliation:
                        requested = []
                    expansions = [identifier for identifier in requested if identifier in linked and any(
                        link.concept_id == identifier and sources[link.unit_id].kind != 'mention' for link in links)]
                    additions = [item for item in proposed.additions if allow_additions
                        and self.chat.valid_citations(item.citations, context.messages)
                        and any(unit.kind != 'mention' and item.parent_concept_id in context.unit_concept_ids[unit.unit_id]
                            and all(any(source.message_id == ref.message_id and ref.quote in source.quote
                                        for source in unit.citations) for ref in item.citations) for unit in fresh)]
                    candidate = ChatStructurePlan(links=links, expand_concept_ids=expansions[:10], additions=additions[:10])
                    if candidate.expand_concept_ids or candidate.additions:
                        context.proposed_plan = candidate
                        review = await self.chat.generate(session_id, turn_id, 'chat_structure_review', context, ChatPlanReview)
                        self.defer(session_id, turn_id, review.deferred_reasons)
                        candidate.expand_concept_ids = [key for key in candidate.expand_concept_ids if key in review.approved_expansions]
                        candidate.additions = [item for index, item in enumerate(candidate.additions) if index in review.approved_additions]
                    if graph != self.chat.evidence_queue.fingerprint(self.repo.get(session_id)):
                        continue
                    for unit in fresh:
                        unit_links = [link for link in candidate.links if link.unit_id == unit.unit_id]
                        unit_plan = ChatStructurePlan(links=unit_links,
                            expand_concept_ids=[key for key in candidate.expand_concept_ids if any(link.concept_id == key for link in unit_links)],
                            additions=[item for item in candidate.additions if all(any(source.message_id == ref.message_id
                                and ref.quote in source.quote for source in unit.citations) for ref in item.citations)])
                        if unit.unit_id in invalid:
                            if not individual_retry:
                                cached.extend(await one([unit], individual_retry=True))
                            else:
                                self.fail_units(session_id, turn_id, [unit], '対応先のIDを確認できませんでした。')
                            continue
                        def save(current, unit=unit, unit_plan=unit_plan):
                            current.chat.routing_records[f'{unit.unit_id}:{reconciliation}:{allow_additions}'] = ChatRoutingRecord(
                                context_hash=hashes[unit.unit_id], plan=unit_plan)
                        self.chat.mutate(session_id, save)
                        self.clear_units(session_id, turn_id, [unit])
                        cached.append(unit_plan)
                    return cached
                except (Exception,) as exc:
                    if len(fresh) > 1 and not individual_retry:
                        outcomes = await asyncio.gather(*(one([unit], individual_retry=True) for unit in fresh))
                        return cached + [plan for plans in outcomes for plan in plans]
                    self.fail_units(session_id, turn_id, fresh, exc)
                    return cached
            self.fail_units(session_id, turn_id, batch, 'マップが更新されたため再照合を保留しています。')
            return []
        plans = []
        # Broad information precedes specific information; unrelated branches remain parallel.
        for granularity in ('domain', 'knowledge', 'specific'):
            groups = self.retrieval.groups([unit for unit in eligible if unit.granularity == granularity],
                                          candidates, self.settings.chat_routing_batch_size)
            for result in await asyncio.gather(*(one(group) for group in groups)):
                plans.extend(result)
        expansions = list(dict.fromkeys(key for plan in plans for key in plan.expand_concept_ids))
        additions, seen = [], set()
        for plan in plans:
            for item in plan.additions:
                key = (item.parent_concept_id, item.concept_name.casefold())
                if key not in seen:
                    additions.append(item)
                    seen.add(key)
        # Limits are applied to a work wave, not to the durable list of candidates.
        return ChatStructurePlan.model_construct(links=[link for plan in plans for link in plan.links],
            expand_concept_ids=expansions, additions=additions)

    def defer(self, session_id, turn_id, reasons):
        def save(session):
            job = next(job for job in session.chat.jobs if job.turn_id == turn_id)
            job.deferred_reasons = list(dict.fromkeys([*job.deferred_reasons, *reasons]))
        self.chat.mutate(session_id, save)

    def assessment_signature(self, node):
        payload = node if isinstance(node, dict) else node.model_dump()
        policy = (Path(__file__).resolve().parents[1] / 'prompts' / 'chat_assessment.txt').read_text(encoding='utf-8')
        return text_hash(json.dumps({key: payload[key] for key in
            ('concept_id', 'concept_name', 'description', 'assessment_targets')}, sort_keys=True, ensure_ascii=False)
            + self.settings.gemini_model + policy)

    async def assess(self, session_id, turn_id, identifiers):
        if not identifiers:
            return set()
        self.progress(session_id, turn_id, 'assessing')
        session = self.repo.get(session_id)
        targets = {node.concept_id: node for node in walk(session.knowledge_tree)
                   if node.concept_id in identifiers and node.depth > 0}
        end = next(index for index, message in enumerate(session.chat.messages) if message.message_id == turn_id)
        turns = {message.message_id for message in session.chat.messages[:end+1] if message.role == 'user'}
        units = [unit for unit in session.chat.experience_units if unit.turn_id in turns and unit.kind != 'mention']
        correspondences = {item.unit_id: set(item.matched_concept_ids) for item in session.chat.evidence_queue}
        for job in session.chat.jobs:
            for link in job.planned_links:
                if not link.needs_detail:
                    correspondences.setdefault(link.unit_id, set()).add(link.concept_id)
        assignments = {}
        # Previously linked nodes use exactly their source units. Newly created
        # abilities search all retained evidence, without a lexical top-40 cutoff.
        new_ids = set(targets) - {identifier for ids in correspondences.values() for identifier in ids}
        vector_results = await asyncio.gather(*(self.retrieval.vector(session, identifier,
            self.diagnostic.deduplicator.semantic_text(session, node,
                find(session, node.parent_concept_id).concept_name if node.parent_concept_id else None))
            for identifier, node in targets.items() if identifier in new_ids), return_exceptions=True)
        new_vectors = dict(zip((identifier for identifier in targets if identifier in new_ids), vector_results))
        async def correspondence(unit):
            matched = {find(session, identifier).concept_id for identifier in correspondences.get(unit.unit_id, ())
                       if find(session, identifier)} & set(targets)
            if new_vectors:
                content = '\n'.join(part for part in (unit.topic, unit.statement, unit.parent_topic) if part)
                try:
                    vector = await self.retrieval.vector(session, 'experience:'+unit.unit_id, content)
                    from app.embeddings import cosine
                    matched.update(identifier for identifier, candidate in new_vectors.items()
                        if not isinstance(candidate, BaseException)
                        and cosine(vector, candidate) >= self.settings.chat_retrieval_min_similarity)
                except Exception as exc:
                    self.fail_units(session_id, unit.turn_id, [unit], exc, stage='assessment')
            return unit.unit_id, sorted(matched)
        assignments.update(await asyncio.gather(*(correspondence(unit) for unit in units)))
        failed = {identifier for identifier, vector in new_vectors.items() if isinstance(vector, BaseException)}
        async def one(batch, wanted, individual_retry=False):
            for attempt in range(3):
                latest = self.repo.get(session_id)
                nodes = self.chat.concepts(latest, '', only_ids=set(wanted))
                wanted_now = {node['concept_id'] for node in nodes}
                relevant = [unit for unit in batch if set(assignments[unit.unit_id]) & wanted_now]
                if not relevant:
                    return
                signatures = {node['concept_id']: self.assessment_signature(node) for node in nodes}
                fresh = {unit.unit_id: [identifier for identifier in assignments[unit.unit_id] if identifier in signatures
                    and latest.chat.assessment_records.get(f'{identifier}:{unit.unit_id}') != signatures[identifier]]
                    for unit in relevant}
                active = [unit for unit in relevant if fresh[unit.unit_id]]
                if not active:
                    return
                selected_ids = {identifier for unit in active for identifier in fresh[unit.unit_id]}
                context = self.chat.evidence_input(latest, turn_id, active,
                    concepts=[node for node in nodes if node['concept_id'] in selected_ids])
                context.unit_concept_ids = {unit.unit_id: fresh[unit.unit_id] for unit in active}
                try:
                    result = await self.chat.generate(session_id, turn_id, 'chat_assessment', context, ChatAssessment)
                    current = self.repo.get(session_id)
                    changed = any(find(current, node['concept_id']) is None or
                        self.assessment_signature(find(current, node['concept_id'])) != signatures[node['concept_id']]
                        for node in context.concepts)
                    if changed:
                        continue
                    allowed_targets = {node['concept_id']: {target['target_id'] for target in node['assessment_targets']}
                                       for node in context.concepts}
                    invalid = any(judgment.target_id not in allowed_targets.get(judgment.concept_id, set())
                        or not self.chat.valid_citations(judgment.citations, context.messages)
                        or any(not any(judgment.concept_id in fresh[unit.unit_id] and any(
                            source.message_id == ref.message_id and ref.quote in source.quote for source in unit.citations)
                            for unit in active) for ref in judgment.citations) for judgment in result.judgments)
                    if invalid and len(active) > 1 and not individual_retry:
                        await asyncio.gather(*(one([unit], wanted, True) for unit in active))
                        return
                    if invalid:
                        for unit in active:
                            self.fail_units(session_id, unit.turn_id, [unit], '判定のIDまたは引用の対応を確認できませんでした。', stage='assessment')
                        failed.update(selected_ids)
                        return
                    saved = self.chat.persist_assessment(session_id, turn_id, result, context)
                    def complete(current):
                        for unit in active:
                            for identifier in fresh[unit.unit_id]:
                                current.chat.assessment_records[f'{identifier}:{unit.unit_id}'] = signatures[identifier]
                    self.chat.mutate(session_id, complete)
                    for unit in active:
                        self.clear_units(session_id, unit.turn_id, [unit], stage='assessment')
                    updated = {item.concept_id for item in saved.chat.observations if item.turn_id == turn_id}
                    self.remember(session_id, turn_id, updated)
                    self.chat.prepare_assessed_branches(saved)
                    return
                except Exception as exc:
                    if len(active) > 1 and not individual_retry:
                        await asyncio.gather(*(one([unit], wanted, True) for unit in active))
                        return
                    for unit in active:
                        self.fail_units(session_id, unit.turn_id, [unit], exc, stage='assessment')
                    failed.update(selected_ids)
                    return
            failed.update(wanted)
            for unit in batch:
                self.fail_units(session_id, unit.turn_id, [unit], '判定中に項目が更新されました。再試行します。', stage='assessment')
        groups = self.retrieval.groups([unit for unit in units if assignments[unit.unit_id]], assignments,
                                      self.settings.chat_assessment_batch_size)
        jobs = []
        for batch in groups:
            wanted = sorted({identifier for unit in batch for identifier in assignments[unit.unit_id]})
            jobs.extend(one(batch, wanted[offset:offset+self.settings.chat_context_nodes])
                        for offset in range(0, len(wanted), self.settings.chat_context_nodes))
        await asyncio.gather(*jobs)
        return failed

    def remember(self, session_id, turn_id, identifiers, opened=None):
        def save(session):
            present = {node.concept_id for node in walk(session.knowledge_tree)}
            job = next(job for job in session.chat.jobs if job.turn_id == turn_id)
            job.updated_concept_ids = sorted((set(job.updated_concept_ids) | set(identifiers)) & present)
            visible_parents = set(opened or [])
            for identifier in list(visible_parents):
                node = find(session, identifier)
                visited = set()
                while node and node.parent_concept_id and node.concept_id not in visited:
                    visited.add(node.concept_id)
                    visible_parents.add(node.parent_concept_id)
                    node = find(session, node.parent_concept_id)
            session.chat.opened_concept_ids = sorted((set(session.chat.opened_concept_ids) | visible_parents) & present)
        self.chat.mutate(session_id, save)

    async def prepare_branch(self, session_id, concept_id):
        async with self.chat.work_limit:
            self.diagnostic.jobs.handoff(session_id, 'recorder', 'miner', concept_id, 'chat_expansion')
            await self.diagnostic.prepare_concept(session_id, concept_id)

    async def process(self, session_id, turn_id):
        units = await self.extract(session_id, turn_id)
        if not units:
            return
        job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
        remaining = self.settings.chat_max_expansions
        phases = [('all', units)] if job.planning_complete and not job.failed_unit_ids else [
            (grain, [unit for unit in units if unit.granularity == grain]) for grain in ('domain', 'knowledge', 'specific')]
        for grain, batch in phases:
            if not batch:
                continue
            if grain == 'all':
                expansions, _, linked = await self.plan(session_id, turn_id, batch)
            else:
                plan = await self.route(session_id, turn_id, batch,
                    allow_additions=not bool(self.diagnostic.generation_tasks(session_id)))
                expansions, linked = plan.expand_concept_ids, {link.concept_id for link in plan.links}
                self.chat.evidence_queue.record_links(session_id, batch, plan.links)
                def store(current):
                    current_job = next(item for item in current.chat.jobs if item.turn_id == turn_id)
                    batch_ids = {unit.unit_id for unit in batch}
                    current_job.planned_links = [link for link in current_job.planned_links if link.unit_id not in batch_ids] + plan.links
                    current_job.planned_expansions = list(dict.fromkeys([*current_job.planned_expansions, *expansions]))
                    additions = {addition_key(item): item for item in [*current_job.planned_additions, *plan.additions]}
                    current_job.planned_additions = list(additions.values())
                    current_job.related_concept_ids = sorted(set(current_job.related_concept_ids) | linked)
                self.chat.mutate(session_id, store)
            # An assessment error is retained per unit; independent decomposition continues.
            updated = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id).updated_concept_ids
            await self.assess(session_id, turn_id, linked | set(updated))
            current_job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
            unfinished = [identifier for identifier in expansions if identifier not in current_job.completed_expansions]
            wave, tail = unfinished[:remaining], unfinished[remaining:]
            remaining = max(0, remaining-len(wave))
            self.progress(session_id, turn_id, pending_expansions=list(dict.fromkeys([*current_job.pending_expansions, *tail])))
            await self.update_expansions(session_id, turn_id, wave)
        self.progress(session_id, turn_id, planning_complete=True)
        self.chat.evidence_queue.refresh(session_id)
        self.chat.request_reconciliation(session_id)
        self.chat.prepare_assessed_branches(self.repo.get(session_id))

    async def continue_expansions(self, session_id, turn_id):
        job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
        wave = job.pending_expansions[:self.settings.chat_max_expansions]
        self.progress(session_id, turn_id, pending_expansions=job.pending_expansions[len(wave):])
        await self.update_expansions(session_id, turn_id, wave)
        if next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id).pending_expansions:
            self.chat.request_reconciliation(session_id)

    async def update_expansions(self, session_id, turn_id, expansions):
        if not expansions:
            return
        self.progress(session_id, turn_id, 'updating')
        self.chat.mutate(session_id, lambda current: setattr(current.chat, 'generating_concept_ids', expansions))
        outcomes = await asyncio.gather(*(self.prepare_branch(session_id, identifier) for identifier in expansions), return_exceptions=True)
        preparation_errors = {identifier: result for identifier, result in zip(expansions, outcomes) if isinstance(result, BaseException)}
        for identifier in expansions:
            latest = self.repo.get(session_id)
            node = find(latest, identifier)
            before = {item.concept_id for item in walk(latest.knowledge_tree)}
            try:
                if identifier in preparation_errors:
                    raise preparation_errors[identifier]
                if node and self.diagnostic.can_expand(latest, node):
                    result = await self.diagnostic.decompose_concept(session_id, identifier, background=True)
                    if result['error']:
                        raise LLMError(result['error'])
                latest = self.repo.get(session_id)
                after = {item.concept_id for item in walk(latest.knowledge_tree)}
                children = {item.concept_id for item in walk(latest.knowledge_tree) if item.parent_concept_id == identifier}
                children.update(edge.target for edge in latest.concept_edges if edge.source == identifier and edge.relation == 'part')
                self.remember(session_id, turn_id, after-before, [identifier] if children else [])
                self.chat.mutate(session_id, lambda current: setattr(current.chat, 'created_concept_ids',
                    sorted(set(current.chat.created_concept_ids) | (after-before))))
                def clear_expansion(current):
                    current_job = next(item for item in current.chat.jobs if item.turn_id == turn_id)
                    for entry in current.chat.evidence_queue:
                        entry.pending_expansion_ids = [value for value in entry.pending_expansion_ids if value != identifier]
                        if entry.failed_stage == 'expansion' and not entry.pending_expansion_ids:
                            entry.processing_error = entry.failed_stage = None
                            current_job.failed_unit_ids = [value for value in current_job.failed_unit_ids if value != entry.unit_id]
                self.chat.mutate(session_id, clear_expansion)
                await self.assess(session_id, turn_id, {identifier, *children})
                current_job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
                self.progress(session_id, turn_id, completed_expansions=list(dict.fromkeys([*current_job.completed_expansions, identifier])))
            except Exception as exc:
                job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
                related_ids = {link.unit_id for link in job.planned_links if link.concept_id == identifier}
                sources = [unit for unit in self.repo.get(session_id).chat.experience_units if unit.unit_id in related_ids]
                self.fail_units(session_id, turn_id, sources, exc, stage='expansion')
                def retain(current):
                    for entry in current.chat.evidence_queue:
                        if entry.unit_id in related_ids:
                            entry.pending_expansion_ids = sorted(set(entry.pending_expansion_ids) | {identifier})
                self.chat.mutate(session_id, retain)
            finally:
                self.chat.mutate(session_id, lambda current: setattr(current.chat, 'generating_concept_ids',
                    [item for item in current.chat.generating_concept_ids if item != identifier]))

    def provisional_understanding(self, session_id, turn_id, identifier, addition):
        def save(session):
            node = find(session, identifier)
            if not node or not node.assessment_targets or any(
                    item.concept_id == identifier for item in session.chat.observations):
                return
            messages = {item.message_id: item.content for item in session.chat.messages
                        if item.role == 'user' and item.status == 'complete'}
            citations = [ref for ref in addition.citations
                         if ref.message_id in messages and ref.quote in messages[ref.message_id]]
            if not citations and messages.get(turn_id, '').strip():
                citations = [Citation(message_id=turn_id, quote=messages[turn_id][:1500])]
            if not citations:
                return
            target = next((item for item in node.assessment_targets if item.importance == 'core'),
                          node.assessment_targets[0])
            session.chat.observations.append(ChatObservation(
                turn_id=turn_id, concept_id=identifier, target_id=target.target_id,
                score=PROVISIONAL_CREATION_SCORE, confidence=.2, kind='self_report', citations=citations[:1],
                reason=PROVISIONAL_CREATION_REASON))
        self.chat.mutate(session_id, save)

    async def apply_additions(self, session_id, turn_id, additions):
        errors = []
        # Generate proposed additions concurrently, apply each against the latest tree.
        session = self.repo.get(session_id)
        completed = next(job for job in session.chat.jobs if job.turn_id == turn_id).applied_additions
        remaining = self.settings.chat_max_additions
        additions = [addition for addition in additions if addition_key(addition) not in completed][:remaining]
        expected_graph = self.chat.evidence_queue.fingerprint(session)
        async def generate_addition(addition):
            if addition_key(addition) in completed:
                return addition, None
            latest = self.repo.get(session_id)
            parent = find(latest, addition.parent_concept_id)
            if parent is None or latest.complete:
                return addition, None
            request = AdditionInput(concept_id=uid('chat'), concept_name=addition.concept_name,
                note=addition.reason, parent_concept=spec(parent), siblings=[spec(child) for child in parent.child_nodes],
                domain_context=latest.domain_context, target_depth=parent.depth+1,
                existing_concept_ids=[node.concept_id for node in walk(latest.knowledge_tree)])
            async with self.diagnostic.jobs.track(session_id, 'miner', parent.concept_id, 'chat_addition', from_role='recorder'):
                result = await ConceptAdditionAgent(self.diagnostic.providers[latest.mode]).run(request)
            return addition, result
        results = await asyncio.gather(*(generate_addition(addition) for addition in additions), return_exceptions=True)
        for result in results:
            if (self.diagnostic.generation_tasks(session_id) or
                    expected_graph != self.chat.evidence_queue.fingerprint(self.repo.get(session_id))):
                self.chat.request_reconciliation(session_id)
                return
            if isinstance(result, BaseException):
                errors.append(str(result))
                continue
            addition, generated = result
            if generated is None:
                continue
            identifier = None
            try:
                known_ids = {node.concept_id for node in walk(self.repo.get(session_id).knowledge_tree)}
                identifier = await self.chat.add_node(session_id, addition, generated=generated)
                if identifier:
                    def save(current):
                        job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
                        job.applied_additions = list(dict.fromkeys([*job.applied_additions, addition_key(addition)]))
                        if identifier not in known_ids:
                            job.pending_expansions = list(dict.fromkeys([*job.pending_expansions, identifier]))
                        current.chat.created_concept_ids = list(dict.fromkeys([*current.chat.created_concept_ids, identifier]))
                    self.chat.mutate(session_id, save)
                    self.chat.evidence_queue.record_addition(session_id, addition, identifier)
                    self.remember(session_id, turn_id, {identifier}, [addition.parent_concept_id])
                    if identifier not in known_ids:
                        self.provisional_understanding(session_id, turn_id, identifier, addition)
                    await self.assess(session_id, turn_id, {identifier, addition.parent_concept_id})
                    expected_graph = self.chat.evidence_queue.fingerprint(self.repo.get(session_id))
            except (LLMError, ValueError, KeyError) as exc:
                if identifier:
                    units = [unit for unit in self.repo.get(session_id).chat.experience_units if unit.turn_id == turn_id
                        and any(source.message_id == ref.message_id and ref.quote in source.quote
                                for source in unit.citations for ref in addition.citations)]
                    self.fail_units(session_id, turn_id, units, exc, stage='assessment')
                errors.append(str(exc))
        # A chat-created concept is a new branch, not just a prepared cache.
        # Publish its first layer now and retain pending work for reconciliation
        # if an earlier step was interrupted.
        if next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id).pending_expansions:
            await self.continue_expansions(session_id, turn_id)
        self.chat.evidence_queue.refresh(session_id)
        if errors:
            raise LLMError('一部の項目を追加できませんでした。成功した更新は保存済みです。')
