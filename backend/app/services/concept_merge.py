from app.services.agent_jobs import tracked
"""Conservative, pre-display deduplication for newly decomposed concepts."""
import asyncio
from difflib import SequenceMatcher
import logging
import time
import json
from pathlib import Path
from app.embeddings import concept_text, text_hash, cosine
from app.models.domain import (CanonicalConcept, ConceptPair, ConceptRelationJudgeResult, ConceptSpec, KnowledgeEdge, MergeProposal, MergedConceptSource,
                               PreparedDecomposition, Target)
from app.policies.learning_state import update
from app.policies.knowledge_graph import acyclic, hierarchy, reachable, validate_merge_structure

logger = logging.getLogger(__name__)


def as_spec(node):
    from app.models.domain import ConceptSpec
    return ConceptSpec.model_validate(node.model_dump(include=set(ConceptSpec.model_fields)))


def walk(node):
    yield node
    for child in node.child_nodes:
        yield from walk(child)


class MergeConflict(ValueError):
    """A checked merge must be reconsidered against a newer graph."""


def creation_source(node):
    # Older chat nodes were saved with origin=generated; preserve compatibility.
    return getattr(node, 'creation_source', None) or ('chat' if node.concept_id.startswith('chat_') else 'decomposition')


MERGE_FIELDS = ('knowledge_tree', 'concept_edges', 'concept_redirects', 'learning_states',
    'self_assessments', 'questions', 'evidence', 'pending_question', 'paused_questions',
    'reassessment', 'pending_review', 'active_concept_id', 'approved_expansion_id',
    'queue', 'deferred_concepts', 'focused_path', 'completed_concepts')
CHAT_MERGE_FIELDS = ('observations', 'opened_concept_ids', 'jobs', 'focus_concept_id',
    'created_concept_ids', 'pending_node_ids', 'failed_node_ids', 'evidence_queue', 'routing_records', 'assessment_records')


def merge_snapshot(session):
    snapshot = session.model_dump(include=set(MERGE_FIELDS))
    snapshot['chat'] = session.chat.model_dump(include=set(CHAT_MERGE_FIELDS))
    return snapshot


def snapshot_hash(snapshot):
    return text_hash(json.dumps(snapshot, ensure_ascii=False, sort_keys=True))


class ConceptDeduplicator:
    def __init__(self, repository, embeddings, llms, settings):
        self.repo = repository
        self.embeddings = embeddings
        self.llms = llms
        self.settings = settings

    def semantic_text(self, session, concept, parent_name):
        return concept_text(session.theme, concept, parent_name)

    async def vector(self, session, concept, parent_name):
        provider = self.embeddings[session.mode]
        content = self.semantic_text(session, concept, parent_name)
        digest = text_hash(content)
        saved = self.repo.get_embedding(session.session_id, concept.concept_id, provider.model, digest)
        if saved is not None:
            return saved
        vector = await provider.embed(content)
        self.repo.save_embedding(session.session_id, concept.concept_id, provider.model, digest, vector)
        return vector

    def parent_name(self, nodes, node):
        parent = nodes.get(node.parent_concept_id) if node.parent_concept_id else None
        return parent.concept_name if parent else None

    def graph_hashes(self, session):
        nodes = {node.concept_id: node for node in walk(session.knowledge_tree)}
        hashes = {cid: text_hash(self.semantic_text(session, node, self.parent_name(nodes, node)))
                  for cid, node in nodes.items()}
        _, children = hierarchy(session)
        hashes['__structure__'] = text_hash(json.dumps({key: sorted(value) for key, value in children.items()}, sort_keys=True))
        return hashes

    async def judge_match(self, session, existing: ConceptSpec, incoming: ConceptSpec,
                          existing_parent: str | None, incoming_parent: str | None,
                          similarity: float, candidate_label: str):
        pair = ConceptPair(existing=existing, incoming=incoming,
            existing_parent=existing_parent, incoming_parent=incoming_parent, theme=session.theme)
        prompts = Path(__file__).resolve().parents[1] / 'prompts'
        key = text_hash(pair.model_dump_json() + self.settings.gemini_model + str(self.settings.concept_merge_confidence_threshold)
            + ''.join((prompts / f'{agent}.txt').read_text(encoding='utf-8') for agent in ('concept_relation', 'concept_canonical')))
        saved = self.repo.get_merge_decision(session.session_id, key)
        if saved is not None:
            return CanonicalConcept.model_validate(saved['canonical']) if saved['canonical'] else None
        try:
            judged = await self.llms[session.mode].generate('concept_relation', pair,
                ConceptRelationJudgeResult, 0)
        except Exception as exc:
            logger.warning('concept_merge_judge_failed session_id=%s new_concept_id=%s candidate_concept_id=%s error=%s',
                session.session_id, incoming.concept_id, candidate_label, type(exc).__name__)
            return None
        accepted = (judged.relation == 'same' and judged.evidence_shareable
                    and judged.confidence >= self.settings.concept_merge_confidence_threshold)
        logger.info('concept_match session_id=%s new_concept_id=%s candidate_concept_id=%s embedding_similarity=%.4f relation=%s confidence=%.3f merge_candidate=%s',
            session.session_id, incoming.concept_id, candidate_label, similarity,
            judged.relation, judged.confidence, accepted)
        if not accepted:
            self.repo.save_merge_decision(session.session_id, key, {'canonical': None})
            return None
        try:
            canonical = await self.llms[session.mode].generate('concept_canonical', pair, CanonicalConcept, 0)
            self.validate_canonical(canonical, existing, incoming)
            self.repo.save_merge_decision(session.session_id, key, {'canonical': canonical.model_dump()})
            return canonical
        except Exception as exc:
            logger.warning('concept_canonical_failed session_id=%s new_concept_id=%s candidate_concept_id=%s error=%s',
                session.session_id, incoming.concept_id, candidate_label, type(exc).__name__)
            return None

    @tracked('merge', 'prepare', from_role='miner')
    async def prepare(self, session, parent, decomposition):
        """Run during prefetch; only accepted proposals are committed with the branch."""
        candidates = {node.concept_id: node for node in walk(session.knowledge_tree)}
        baseline_ids = list(candidates)
        baseline_hashes = self.graph_hashes(session)
        # Embeddings for the whole new layer and any missing index entries are independent.
        try:
            jobs = [(node, self.parent_name(candidates, node)) for node in candidates.values() if node.depth > 0]
            jobs.extend((node, parent.concept_name) for node in decomposition.child_nodes)
            outcomes = await asyncio.gather(*(self.vector(session, node, parent_name)
                                              for node, parent_name in jobs), return_exceptions=True)
            if any(isinstance(result, Exception) for result in outcomes):
                logger.warning('concept_merge_skipped session_id=%s reason=embedding_unavailable', session.session_id)
                return PreparedDecomposition(decomposition=decomposition,
                    compared_concept_ids=baseline_ids, compared_concept_hashes=baseline_hashes)
        except Exception as exc:
            logger.warning('concept_merge_skipped session_id=%s reason=%s', session.session_id, type(exc).__name__)
            return PreparedDecomposition(decomposition=decomposition,
                compared_concept_ids=baseline_ids, compared_concept_hashes=baseline_hashes)
        proposals = []
        for incoming in decomposition.child_nodes:
            proposal = await self.propose(session, parent, incoming, candidates)
            if proposal:
                proposals.append(proposal)
            else:
                # Earlier siblings can be duplicate candidates too.
                from app.models.domain import Node
                candidates[incoming.concept_id] = Node(**incoming.model_dump(),
                    parent_concept_id=parent.concept_id, depth=parent.depth + 1)
        return PreparedDecomposition(decomposition=decomposition, proposals=proposals,
            compared_concept_ids=baseline_ids, compared_concept_hashes=baseline_hashes)

    @tracked('merge', 'propose')
    async def propose(self, session, parent, incoming, candidates=None):
        started = time.monotonic()
        candidates = candidates or {node.concept_id: node for node in walk(session.knowledge_tree)}
        try:
            new_vector = await self.vector(session, incoming, parent.concept_name)
            ordered = [candidate for candidate in candidates.values()
                       if candidate.concept_id not in (incoming.concept_id, parent.concept_id)
                       and candidate.depth > 0 and candidate.concept_id != session.knowledge_tree.concept_id]
            _, children = hierarchy(session)
            for candidate in candidates.values():
                children.setdefault(candidate.concept_id, set())
                if candidate.parent_concept_id in children:
                    children[candidate.parent_concept_id].add(candidate.concept_id)
            if not acyclic(children):
                return None
            ordered = [candidate for candidate in ordered
                       if not reachable(children, candidate.concept_id, parent.concept_id)]
            vectors = await asyncio.gather(*(self.vector(session, candidate, self.parent_name(candidates, candidate))
                                             for candidate in ordered), return_exceptions=True)
            scored = sorted(((cosine(new_vector, vector), candidate) for candidate, vector in zip(ordered, vectors)
                             if isinstance(vector, list)), key=lambda pair: pair[0], reverse=True)
            if scored and self.settings.concept_related_threshold <= scored[0][0] < self.settings.concept_merge_candidate_threshold:
                logger.info('concept_related_only session_id=%s new_concept_id=%s candidate_concept_id=%s embedding_similarity=%.4f',
                    session.session_id, incoming.concept_id, scored[0][1].concept_id, scored[0][0])
            for similarity, candidate in scored[:self.settings.concept_merge_top_k]:
                if similarity < self.settings.concept_merge_candidate_threshold:
                    break
                canonical = await self.judge_match(session, as_spec(candidate), as_spec(incoming),
                    self.parent_name(candidates, candidate), parent.concept_name,
                    similarity, candidate.concept_id)
                if canonical is None:
                    continue
                digest = text_hash(self.semantic_text(session, candidate, self.parent_name(candidates, candidate)))
                return MergeProposal(incoming_id=incoming.concept_id, existing_id=candidate.concept_id,
                    existing_text_hash=digest, canonical=canonical, similarity=similarity)
        except Exception as exc:
            logger.warning('concept_merge_skipped session_id=%s new_concept_id=%s error=%s',
                session.session_id, incoming.concept_id, type(exc).__name__)
        return None

    @tracked('merge', 'propose_other_maps')
    async def propose_other_maps(self, session, incoming):
        """Compare unique canonical concepts used outside this map only."""
        started = time.monotonic()
        refs = self.repo.canonical_refs(session.session_id)
        current_canonical = {item['canonical_id'] for item in refs.values()}
        provider = self.embeddings[session.mode]
        candidates = [item for item in self.repo.other_canonical_concepts(
            session.session_id, provider.model)
                      if item['canonical_id'] not in current_canonical]
        if not candidates:
            return None
        nodes = {node.concept_id: node for node in walk(session.knowledge_tree)}
        parent = nodes.get(incoming.parent_concept_id)
        parent_name = parent.concept_name if parent else None
        try:
            new_vector = await self.vector(session, incoming, parent_name)
            # Existing vectors are read in one query. Older concepts without an
            # index are sampled conservatively so opening a map cannot trigger
            # thousands of billable embedding requests.
            indexed = [(item, item['embedding']) for item in candidates if item['embedding'] is not None]
            missing = [item for item in candidates if item['embedding'] is None]
            missing.sort(key=lambda item: (
                item['concept']['concept_name'] == incoming.concept_name,
                item['theme'] == session.theme,
                SequenceMatcher(None, item['concept']['concept_name'], incoming.concept_name).ratio()),
                reverse=True)
            vectors = list(indexed)
            for item in missing[:self.settings.cross_map_missing_embed_limit]:
                other = ConceptSpec.model_validate(item['concept'])
                content = concept_text(item['theme'], other, None)
                vector = self.repo.get_embedding(item['map_id'], item['concept_id'],
                                                 provider.model, text_hash(content))
                if vector is None:
                    vector = await provider.embed(content)
                    self.repo.save_embedding(item['map_id'], item['concept_id'],
                                             provider.model, text_hash(content), vector)
                vectors.append((item, vector))
            scored = sorted(((cosine(new_vector, vector), item) for item, vector in vectors),
                            key=lambda pair: pair[0], reverse=True)
            logger.info('cross_map_candidates map_id=%s concept_id=%s candidate_ids=%s similarities=%s embedding_ms=%d',
                session.session_id, incoming.concept_id,
                [item['canonical_id'] for _, item in scored[:self.settings.concept_merge_top_k]],
                [round(score, 4) for score, _ in scored[:self.settings.concept_merge_top_k]],
                round((time.monotonic() - started) * 1000))
            for similarity, item in scored[:self.settings.concept_merge_top_k]:
                if similarity < self.settings.concept_merge_candidate_threshold:
                    break
                existing = ConceptSpec.model_validate(item['concept'])
                canonical = await self.judge_match(session, existing, as_spec(incoming),
                    None, parent_name, similarity, item['canonical_id'])
                if canonical is None:
                    continue
                existing_mapping = self.repo.canonical_refs(item['map_id'])[item['concept_id']]['target_mapping']
                target_mapping = {}
                for target in canonical.targets:
                    old_ids = [source.split(':', 1)[1] for source in target.source_target_ids
                               if source.startswith('existing:')]
                    new_ids = [source.split(':', 1)[1] for source in target.source_target_ids
                               if source.startswith('incoming:')]
                    if len(old_ids) != 1:
                        target_mapping = {}
                        break
                    for local_id in new_ids:
                        target_mapping[local_id] = existing_mapping[old_ids[0]]
                if (set(target_mapping) != {target.target_id for target in incoming.assessment_targets}
                        or len(set(target_mapping.values())) != len(target_mapping)):
                    logger.info('cross_map_merge_skipped map_id=%s concept_id=%s reason=ambiguous_target_mapping',
                                session.session_id, incoming.concept_id)
                    continue
                return item['canonical_id'], target_mapping
        except Exception as exc:
            logger.warning('cross_map_merge_skipped map_id=%s concept_id=%s reason=%s',
                           session.session_id, incoming.concept_id, type(exc).__name__)
        return None

    @staticmethod
    def validate_canonical(canonical, existing, incoming):
        expected = {f'existing:{t.target_id}' for t in existing.assessment_targets} | \
                   {f'incoming:{t.target_id}' for t in incoming.assessment_targets}
        supplied = [source for target in canonical.targets for source in target.source_target_ids]
        if set(supplied) != expected or len(supplied) != len(set(supplied)):
            raise ValueError('Canonical target mapping is incomplete or ambiguous')

    def apply(self, session, parent, incoming, proposal, origin='generated', user_note=None, source='decomposition'):
        from app.models.domain import Node
        existing = next((node for node in walk(session.knowledge_tree) if proposal and node.concept_id == proposal.existing_id), None)
        if existing is not None:
            nodes = {node.concept_id: node for node in walk(session.knowledge_tree)}
            digest = text_hash(self.semantic_text(session, existing, self.parent_name(nodes, existing)))
            if digest == proposal.existing_text_hash and existing.concept_id != parent.concept_id:
                try:
                    self.validate_canonical(proposal.canonical, existing, incoming)
                    self.merge(session, parent, existing, incoming, proposal.canonical,
                        incoming_origin=origin, incoming_note=user_note, incoming_source=source)
                    logger.info('concept_merge_executed session_id=%s new_concept_id=%s candidate_concept_id=%s canonical_concept_id=%s',
                        session.session_id, incoming.concept_id, existing.concept_id, existing.concept_id)
                    return existing
                except MergeConflict:
                    raise
                except Exception as exc:
                    logger.warning('concept_merge_apply_failed session_id=%s new_concept_id=%s error=%s',
                        session.session_id, incoming.concept_id, type(exc).__name__)
            else:
                raise MergeConflict('統合候補が更新されたため再照合します。')
        elif proposal:
            raise MergeConflict('統合候補が別の項目へ統合されたため再照合します。')
        child = Node(**incoming.model_dump(), parent_concept_id=parent.concept_id,
            parent_ids=[parent.concept_id], depth=parent.depth+1, origin=origin, user_note=user_note, creation_source=source)
        parent.child_nodes.append(child)
        session.learning_states[child.concept_id] = update(child, [], session.config)
        return child

    def merge(self, session, parent, existing, incoming, canonical, incoming_origin='generated', incoming_note=None, incoming_source='decomposition'):
        self.validate_canonical(canonical, existing, incoming)
        promote = creation_source(existing) == 'chat' and incoming_source == 'decomposition'
        retain_parent = not (creation_source(existing) == 'decomposition' and incoming_source == 'chat')
        validate_merge_structure(session, parent.concept_id, existing.concept_id, incoming.concept_id,
                                 promote=promote, retain_parent=retain_parent)
        before = merge_snapshot(session)
        if not existing.merged_sources:
            existing.merged_sources.append(MergedConceptSource(concept=as_spec(existing),
                parent_concept_id=existing.parent_concept_id, origin=existing.origin,
                user_note=existing.user_note))
        existing.merged_sources.append(MergedConceptSource(concept=as_spec(incoming),
            parent_concept_id=parent.concept_id, origin=incoming_origin, user_note=incoming_note))
        old_targets = list(existing.assessment_targets)
        new_targets = []
        target_mapping = {}
        source_mapping = {}
        for index, item in enumerate(canonical.targets):
            old = next((target for target in old_targets if f'existing:{target.target_id}' in item.source_target_ids), None)
            target_id = old.target_id if old else f'merged_{index+1}'
            while target_id in {target.target_id for target in new_targets}:
                target_id += '_x'
            new_targets.append(Target(target_id=target_id, description=item.description,
                knowledge_type=item.knowledge_type, importance=item.importance))
            lineage = []
            for source in item.source_target_ids:
                side, original_id = source.split(':', 1)
                if side == 'existing':
                    lineage.extend(existing.source_target_ids.get(original_id,
                        [f'{existing.concept_id}:{original_id}']))
                else:
                    lineage.extend(getattr(incoming, 'source_target_ids', {}).get(original_id,
                        [f'{incoming.concept_id}:{original_id}']))
            source_mapping[target_id] = list(dict.fromkeys(lineage))
            for source in item.source_target_ids:
                target_mapping[source] = target_id
        # Preserve source identities and recalculate from evidence, never average scores.
        old_name = existing.concept_name
        existing.concept_name = canonical.name
        existing.description = canonical.description
        existing.aliases = [name for name in dict.fromkeys(existing.aliases + getattr(incoming, 'aliases', []) + canonical.aliases +
            [old_name, incoming.concept_name]) if name != canonical.name]
        existing.merged_from_ids = list(dict.fromkeys(existing.merged_from_ids + getattr(incoming, 'merged_from_ids', []) + [incoming.concept_id]))
        existing.assessment_targets = new_targets
        existing.source_target_ids = source_mapping
        if promote:
            old_parent = next((node for node in walk(session.knowledge_tree)
                               if node.concept_id == existing.parent_concept_id), None)
            if old_parent:
                old_parent.child_nodes = [node for node in old_parent.child_nodes if node.concept_id != existing.concept_id]
            session.concept_edges = [edge for edge in session.concept_edges
                if not (edge.target == existing.concept_id and edge.relation == 'part')]
            delta = parent.depth + 1 - existing.depth
            for node in walk(existing):
                node.depth += delta
            existing.parent_concept_id = parent.concept_id
            existing.parent_ids = [parent.concept_id]
            existing.creation_source = 'decomposition'
            if not any(node.concept_id == existing.concept_id for node in parent.child_nodes):
                parent.child_nodes.append(existing)
        elif retain_parent:
            if existing.parent_concept_id and existing.parent_concept_id not in existing.parent_ids:
                existing.parent_ids.insert(0, existing.parent_concept_id)
            if parent.concept_id not in existing.parent_ids:
                existing.parent_ids.append(parent.concept_id)
            if parent.concept_id != existing.parent_concept_id and not any(
                    edge.source == parent.concept_id and edge.target == existing.concept_id and edge.relation == 'part'
                    for edge in session.concept_edges):
                session.concept_edges.append(KnowledgeEdge(source=parent.concept_id, target=existing.concept_id))
        session.concept_redirects[incoming.concept_id] = existing.concept_id
        question_targets = {}
        for question in session.questions:
            if question.concept_id in (existing.concept_id, incoming.concept_id):
                source = 'existing' if question.concept_id == existing.concept_id else 'incoming'
                mapped_target = target_mapping[f'{source}:{question.assessment_target_id}']
                question_targets[question.question_id] = mapped_target
                question.assessment_target_id = mapped_target
                question.concept_id = existing.concept_id
        for evidence in session.evidence:
            if evidence.concept_id in (existing.concept_id, incoming.concept_id):
                source = 'existing' if evidence.concept_id == existing.concept_id else 'incoming'
                evidence.assessment_target_id = target_mapping[f'{source}:{evidence.assessment_target_id}']
                evidence.concept_id = existing.concept_id
        for observation in session.chat.observations:
            if observation.concept_id in (existing.concept_id, incoming.concept_id):
                source = 'existing' if observation.concept_id == existing.concept_id else 'incoming'
                observation.target_id = target_mapping[f'{source}:{observation.target_id}']
                observation.concept_id = existing.concept_id
        session.chat.opened_concept_ids = list(dict.fromkeys(
            existing.concept_id if identifier == incoming.concept_id else identifier
            for identifier in session.chat.opened_concept_ids))
        for job in session.chat.jobs:
            job.updated_concept_ids = list(dict.fromkeys(
                existing.concept_id if identifier == incoming.concept_id else identifier
                for identifier in job.updated_concept_ids))
        for item in session.chat.evidence_queue:
            for field in ('matched_concept_ids', 'detail_concept_ids', 'added_concept_ids', 'pending_expansion_ids'):
                setattr(item, field, list(dict.fromkeys(existing.concept_id if value == incoming.concept_id else value
                                                       for value in getattr(item, field))))
        for field in ('pending_node_ids', 'failed_node_ids'):
            setattr(session.chat, field, list(dict.fromkeys(existing.concept_id if value == incoming.concept_id else value
                for value in getattr(session.chat, field))))
        for job in session.chat.jobs:
            for link in job.planned_links:
                if link.concept_id == incoming.concept_id:
                    link.concept_id = existing.concept_id
            for field in ('related_concept_ids', 'planned_expansions', 'completed_expansions', 'pending_expansions'):
                setattr(job, field, list(dict.fromkeys(existing.concept_id if value == incoming.concept_id else value
                                                       for value in getattr(job, field))))
        # Target meanings changed; cached assessment and placement must be revalidated.
        session.chat.routing_records = {}
        session.chat.assessment_records = {key: value for key, value in session.chat.assessment_records.items()
            if not key.startswith(existing.concept_id+':') and not key.startswith(incoming.concept_id+':')}
        if session.chat.focus_concept_id == incoming.concept_id:
            session.chat.focus_concept_id = existing.concept_id
        session.chat.created_concept_ids = list(dict.fromkeys(existing.concept_id if identifier == incoming.concept_id else identifier
            for identifier in session.chat.created_concept_ids))
        for question in [session.pending_question, *session.paused_questions.values(),
                         session.reassessment.question if session.reassessment else None]:
            if question and question.question_id in question_targets:
                question.concept_id = existing.concept_id
                question.assessment_target_id = question_targets[question.question_id]
        if incoming.concept_id in session.paused_questions:
            session.paused_questions[existing.concept_id] = session.paused_questions.pop(incoming.concept_id)
        if session.reassessment and session.reassessment.concept_id == incoming.concept_id:
            session.reassessment.concept_id = existing.concept_id
        if session.pending_review and session.pending_review.concept_id == incoming.concept_id:
            session.pending_review.concept_id = existing.concept_id
        for attr in ('active_concept_id', 'approved_expansion_id'):
            if getattr(session, attr) == incoming.concept_id:
                setattr(session, attr, existing.concept_id)
        for attr in ('queue', 'deferred_concepts', 'focused_path', 'completed_concepts'):
            setattr(session, attr, list(dict.fromkeys(existing.concept_id if cid == incoming.concept_id else cid
                                                     for cid in getattr(session, attr))))
        session.learning_states.pop(incoming.concept_id, None)
        incoming_survey = session.self_assessments.pop(incoming.concept_id, None)
        if incoming_survey and existing.concept_id not in session.self_assessments:
            session.self_assessments[existing.concept_id] = incoming_survey
        state = update(existing, session.evidence, session.config)
        session.learning_states[existing.concept_id] = state
        existing.status = state.status
        session.merge_history.append(dict(merge_id='merge_'+text_hash(existing.concept_id+incoming.concept_id+str(session.revision))[:24],
            existing_id=existing.concept_id, incoming_id=incoming.concept_id,
            reason='AIが同一の能力と根拠の共有を確認しました。', before=before,
            after_hash=snapshot_hash(merge_snapshot(session)), reverted=False))

    def restore_merge(self, session, merge_id):
        """Undo only while affected state still matches; never discard later answers."""
        event = next(item for item in session.merge_history if item['merge_id'] == merge_id)
        if event['reverted'] or event['after_hash'] != snapshot_hash(merge_snapshot(session)):
            raise MergeConflict('統合後の情報が更新されているため、そのまま復元できません。')
        from app.models.domain import Session
        payload = session.model_dump()
        payload.update({key: value for key, value in event['before'].items() if key != 'chat'})
        payload['chat'].update(event['before']['chat'])
        restored = Session.model_validate(payload)
        for field in (*MERGE_FIELDS, 'chat'):
            setattr(session, field, getattr(restored, field))
        event['reverted'] = True

    def merge_existing(self, session, existing_id, duplicate_id, canonical):
        """Reconcile two persisted nodes, including both sides' evidence and descendants."""
        nodes = {node.concept_id: node for node in walk(session.knowledge_tree)}
        existing, duplicate = nodes[existing_id], nodes[duplicate_id]
        parent = nodes.get(duplicate.parent_concept_id)
        if parent is None or existing_id == duplicate_id or any(
                node.concept_id == existing_id for node in walk(duplicate)):
            raise ValueError('Cannot merge the root or an ancestor into its descendant')
        self.validate_canonical(canonical, existing, duplicate)
        secondary_parents = [edge.source for edge in session.concept_edges
                             if edge.target == duplicate_id and edge.relation == 'part']
        self.merge(session, parent, existing, duplicate, canonical,
            incoming_origin=duplicate.origin, incoming_note=duplicate.user_note, incoming_source=creation_source(duplicate))
        for child in duplicate.child_nodes:
            delta = existing.depth + 1 - child.depth
            child.parent_concept_id = existing_id
            child.parent_ids = [existing_id if cid == duplicate_id else cid for cid in child.parent_ids]
            for descendant in walk(child):
                descendant.depth += delta
            existing.child_nodes.append(child)
        parent.child_nodes = [child for child in parent.child_nodes if child.concept_id != duplicate_id]
        if creation_source(existing) == 'decomposition' and creation_source(duplicate) == 'chat':
            session.concept_edges = [edge for edge in session.concept_edges if edge.target != duplicate_id or edge.relation != 'part']
            secondary_parents = []
        for source in secondary_parents:
            if source != existing_id and source not in existing.parent_ids:
                existing.parent_ids.append(source)
        rewritten = []
        seen = set()
        for edge in session.concept_edges:
            edge.source = existing_id if edge.source == duplicate_id else edge.source
            edge.target = existing_id if edge.target == duplicate_id else edge.target
            key = (edge.source, edge.target, edge.relation)
            if edge.source != edge.target and key not in seen:
                rewritten.append(edge)
                seen.add(key)
        session.concept_edges = rewritten
        for old, target in list(session.concept_redirects.items()):
            if target == duplicate_id:
                session.concept_redirects[old] = existing_id
        for node in walk(session.knowledge_tree):
            node.prerequisite_concept_ids = list(dict.fromkeys(
                session.concept_redirects.get(cid, cid) for cid in node.prerequisite_concept_ids))

        session.merge_history[-1]['after_hash'] = snapshot_hash(merge_snapshot(session))
