# ==============================================================================
# マップ管理・展開探索サービス (Map Service)
# 用途: 派生マップ管理、マップ系譜（Lineage）追跡、展開候補テーマ生成、横断ノード検索
# ==============================================================================
import asyncio
import logging
import time

from app.agents.divergence import DivergenceAgent
from app.llm.base import LLMError
from app.models.domain import StartRequest
from app.models.maps import DivergenceBatch, DivergenceCandidate, DivergenceCandidateDraft, DivergenceInput
from app.policies.conversation import public_observation
from app.policies.understanding import summaries
from app.services.diagnostic import find, spec, walk

logger = logging.getLogger(__name__)


def walk_paths(node, ancestors=()):
    """ツリーノードとその祖先パス（ノード名一覧）をタプルで走査するジェネレータ"""
    path = (*ancestors, node.concept_name)
    yield node, path
    for child in node.child_nodes:
        yield from walk_paths(child, path)


class MapService:
    """知識マップの作成・派生・横断集計・展開探索を提供するサービス"""
    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        self.repo = diagnostic.repo
        self.settings = diagnostic.settings
        self._divergence_locks = {}


    def _stats(self, map_id):
        session = self.repo.get(map_id)
        nodes = list(walk(session.knowledge_tree))
        summary = summaries(session)
        non_root = nodes[1:]
        return dict(explored_concepts=len(non_root),
            diagnosed_concepts=sum(summary[node.concept_id]['level'] != 'unknown' for node in non_root),
            question_answers=sum(item.origin_map_id in (None, map_id) for item in session.evidence),
            survey_answers=sum(item.origin_map_id in (None, map_id)
                               for item in session.self_assessments.values()),
            weak_concepts=sum(summary[node.concept_id]['level'] == 'low' for node in non_root))

    def _owned_map_ids(self, user_id):
        return {item['session_id'] for item in self.repo.list_sessions(user_id=user_id)}

    def _decorate(self, item, stats=True, visible_ids=None):
        result = dict(item)
        if stats:
            result['stats'] = self._stats(item['map_id'])
        if item['origin']:
            if visible_ids is not None and item['origin']['source_map_id'] not in visible_ids:
                result['origin'] = None
                return result
            try:
                source = self.repo.get_map(item['origin']['source_map_id'])
                result['origin'] = {**item['origin'], 'source_map_title': source['title'],
                    'source_concept_name': find(self.repo.get(source['map_id']),
                                                item['origin']['source_concept_id']).concept_name}
            except (KeyError, AttributeError):
                pass
        return result

    def list_maps(self, user_id):
        visible_ids = self._owned_map_ids(user_id)
        maps = [self._decorate(item, visible_ids=visible_ids)
                for item in self.repo.list_maps() if item['map_id'] in visible_ids]
        map_ids = {item['map_id'] for item in maps}
        by_id = {item['map_id']: item for item in maps}
        lineages = []
        for lineage in self.repo.list_lineages():
            ids = [map_id for map_id in lineage['map_ids'] if map_id in map_ids]
            if not ids:
                continue
            root_id = lineage['root_map_id'] if lineage['root_map_id'] in map_ids else ids[0]
            lineages.append({**lineage, 'map_ids': ids, 'root_map_id': root_id,
                             'title': lineage['title'] if lineage['root_map_id'] in map_ids
                             else f"{by_id[root_id]['title']}系統"})
        return dict(maps=maps,
                    lineages=lineages,
                    relations=[item for item in self.repo.list_map_relations()
                               if item['source_map_id'] in map_ids and item['target_map_id'] in map_ids],
                    candidates=[item for item in self.repo.list_divergence_candidates()
                                if item['source_map_id'] in map_ids and
                                (not item.get('target_map_id') or item['target_map_id'] in map_ids)])

    def get_map(self, map_id, user_id=None):
        visible_ids = self._owned_map_ids(user_id) if user_id is not None else None
        item = self._decorate(self.repo.get_map(map_id), visible_ids=visible_ids)
        item['session'] = self.diagnostic.public(self.repo.get(map_id))
        item['history'] = self.history(map_id)
        return item

    async def divergence(self, map_id, concept_id, on_progress=None):
        # 同じマップでの生成が重なっても、後の処理は先の候補を除外する。
        async with self._divergence_locks.setdefault(map_id, asyncio.Lock()):
            return await self._divergence_once(map_id, concept_id, on_progress=on_progress)

    async def _divergence_once(self, map_id, concept_id, on_progress=None):
        started = time.monotonic()
        session = self.repo.get(map_id)
        node = find(session, concept_id)
        if node is None:
            raise KeyError(concept_id)
        path = []
        cursor = node
        while cursor:
            path.append(cursor.concept_name)
            cursor = find(session, cursor.parent_concept_id) if cursor.parent_concept_id else None
        visible_ids = self._owned_map_ids(session.user_id)
        request = DivergenceInput(knowledge_map_theme=session.theme, scope=session.domain_context,
            selected_concept=spec(node), concept_path=list(reversed(path)),
            candidate_count=self.settings.effective_divergence_candidate_count,
            existing_map_themes=list(dict.fromkeys(
                item['title'] for item in self.repo.list_maps()
                if item['map_id'] in visible_ids)),
            previous_candidates=[DivergenceCandidateDraft(**{key: item[key]
                for key in ('name', 'category', 'relation', 'reason')})
                for item in self.repo.list_divergence_candidates(map_id)])
        await self.diagnostic._notify(on_progress, "DivergenceAgent", "exploring", f"概念「{node.concept_name}」からの発展・応用テーマを探索中...", concept_id=node.concept_id, concept_name=node.concept_name)
        logger.info('divergence_request source_map_id=%s source_concept_id=%s candidate_count=%d',
                    map_id, node.concept_id, request.candidate_count)
        await self.diagnostic._notify(on_progress, "DivergenceAgent", "generating", "展開候補テーマ一覧を生成中...", concept_id=node.concept_id, concept_name=node.concept_name)
        async with self.diagnostic.jobs.track(map_id, 'miner', concept_id, 'divergence'):
            output = await DivergenceAgent(self.diagnostic.providers[session.mode]).run(request)
        current = self.repo.get(map_id)
        if find(current, concept_id) is None:
            raise KeyError(concept_id)
        batch = DivergenceBatch(source_map_id=map_id, source_concept_id=node.concept_id,
            source_concept_name=node.concept_name,
            candidates=[DivergenceCandidate(**item.model_dump()) for item in output.divergent_nodes])
        self.repo.ensure_map(map_id)
        self.repo.save_divergence(batch)
        logger.info('divergence_candidates source_map_id=%s source_concept_id=%s candidate_count=%d candidate_names=%s processing_ms=%d',
                    map_id, node.concept_id, len(batch.candidates),
                    [item.name for item in batch.candidates], round((time.monotonic()-started)*1000))
        await self.diagnostic._notify(on_progress, "DivergenceAgent", "ready", f"「{node.concept_name}」から{len(batch.candidates)}件の展開候補を生成完了", concept_id=node.concept_id, concept_name=node.concept_name)
        return batch.model_dump()

    async def create_from_candidate(self, map_id, concept_id, candidate_id, on_progress=None):
        started = time.monotonic()
        source = self.repo.get(map_id)
        candidate = self.repo.get_divergence_candidate(map_id, concept_id, candidate_id)
        if candidate['target_map_id']:
            if self.repo.get(candidate['target_map_id']).user_id != source.user_id:
                raise PermissionError('このマップへのアクセス権がありません。')
            return self.get_map(candidate['target_map_id'], source.user_id)
        if find(source, concept_id) is None:
            raise KeyError(concept_id)
        self.repo.ensure_map(map_id)
        logger.info('divergence_selected source_map_id=%s source_concept_id=%s selected_candidate=%s',
                    map_id, concept_id, candidate['name'])
        await self.diagnostic._notify(on_progress, "DecompositionAgent", "initializing", f"新テーマ「{candidate['name']}」の派生マップを構築中...", concept_name=candidate['name'])
        origin = {key: candidate[key] for key in ('source_map_id', 'source_concept_id',
                                                   'category', 'relation', 'reason')}
        created = await self.diagnostic.start(StartRequest(theme=candidate['name'],
            mode=source.mode, exploration_mode='manual'), origin=origin, candidate_id=candidate_id,
            on_progress=on_progress, user_id=source.user_id)
        logger.info('divergence_map_created source_map_id=%s source_concept_id=%s selected_candidate=%s created_map_id=%s total_processing_ms=%d',
                    map_id, concept_id, candidate['name'], created['session_id'],
                    round((time.monotonic()-started)*1000))
        return self.get_map(created['session_id'], source.user_id)

    def update_map(self, map_id, request, user_id):
        return self._decorate(self.repo.update_map(map_id, request.title, request.scope),
                              visible_ids=self._owned_map_ids(user_id))

    async def delete_map(self, map_id):
        self.repo.get_map(map_id)
        tasks = [task for (session_id, _), task in self.diagnostic._prefetch_tasks.items()
                 if session_id == map_id and not task.done()]
        initial = self.diagnostic._initial_tasks.get(map_id)
        if initial and not initial.done():
            tasks.append(initial)
        tasks.extend(task for task in self.diagnostic._cross_map_tasks.get(map_id, ())
                     if not task.done())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.repo.delete_map(map_id)
        logger.info('knowledge_map_deleted map_id=%s', map_id)
        return {'deleted_map_id': map_id}

    def lineages(self, user_id):
        return self.list_maps(user_id)['lineages']

    def lineage(self, lineage_id, user_id):
        item = next((lineage for lineage in self.lineages(user_id)
                     if lineage['lineage_id'] == lineage_id), None)
        if item is None:
            raise KeyError(lineage_id)
        visible_ids = self._owned_map_ids(user_id)
        return {**item, 'maps': [self._decorate(self.repo.get_map(map_id), visible_ids=visible_ids)
                                 for map_id in item['map_ids']]}

    def understanding(self, user_id):
        return {'title': 'すべての知識', 'lineages': [
            {**item, 'map_count': len(item['map_ids'])} for item in self.lineages(user_id)]}

    def understanding_lineage(self, lineage_id, user_id):
        return self.lineage(lineage_id, user_id)

    def understanding_map(self, lineage_id, map_id, user_id):
        item = self.repo.get_map(map_id)
        if item['lineage_id'] != lineage_id:
            raise KeyError(map_id)
        visible_ids = self._owned_map_ids(user_id)
        session = self.repo.get(map_id)
        summary = summaries(session)
        refs = self.repo.canonical_refs(map_id)
        return {'map': self._decorate(item, visible_ids=visible_ids), 'concepts': [dict(
            concept_id=node.concept_id, concept_name=node.concept_name,
            depth=node.depth, status=session.learning_states[node.concept_id].status,
            **summary[node.concept_id], other_map_ids=[other for other in
                refs.get(node.concept_id, {}).get('other_maps', []) if other in visible_ids])
            for node in walk(session.knowledge_tree)]}

    def knowledge_nodes(self, q='', map_id=None, level='all', sort='priority', page=1,
                        page_size=50, user_id='guest_user'):
        """Group verified equivalents while preserving every map-level estimate."""
        visible_ids = self._owned_map_ids(user_id)
        maps = [item for item in self.repo.list_maps() if item['map_id'] in visible_ids]
        if map_id is not None and map_id not in {item['map_id'] for item in maps}:
            raise KeyError(map_id)
        query = q.strip().casefold()
        groups = {}
        for item in maps:
            session = self.repo.get(item['map_id'])
            summary = summaries(session)
            refs = self.repo.canonical_refs(item['map_id'])
            answers = {}
            shared_answers = {}
            evidence_ids = {}
            last_activity = {}
            for evidence in session.evidence:
                identifier = evidence.concept_id
                answers[identifier] = answers.get(identifier, 0) + 1
                evidence_ids.setdefault(identifier, set()).add(evidence.evidence_id)
                if evidence.origin_map_id not in (None, item['map_id']):
                    shared_answers[identifier] = shared_answers.get(identifier, 0) + 1
                timestamp = evidence.answered_at or session.created_at
                last_activity[identifier] = max(last_activity.get(identifier, ''), timestamp)
            for identifier, survey in session.self_assessments.items():
                last_activity[identifier] = max(last_activity.get(identifier, ''), survey.answered_at)
            for observation in session.chat.observations:
                last_activity[observation.concept_id] = max(last_activity.get(observation.concept_id, ''), observation.created_at)
            for node, path in walk_paths(session.knowledge_tree):
                if node.depth == 0:
                    continue
                state = summary[node.concept_id]
                survey = session.self_assessments.get(node.concept_id)
                canonical_id = refs.get(node.concept_id, {}).get('canonical_id')
                key = canonical_id or f'{item["map_id"]}:{node.concept_id}'
                occurrence = dict(map_id=item['map_id'], map_title=item['title'],
                    lineage_id=item['lineage_id'], concept_id=node.concept_id,
                    concept_name=node.concept_name, description=node.description,
                    path=list(path),
                    depth=node.depth, level=state['level'],
                    confidence_level=state['confidence_level'], source=state['source'],
                    direct_question_answers=answers.get(node.concept_id, 0),
                    shared_question_answers=shared_answers.get(node.concept_id, 0),
                    self_assessment=survey.level if survey else None,
                    last_assessed_at=last_activity.get(node.concept_id),
                    assessment_scope=node.assessment_scope)
                group = groups.setdefault(key, {'occurrences': [], 'evidence_ids': set()})
                group['occurrences'].append(occurrence)
                group['evidence_ids'].update(evidence_ids.get(node.concept_id, set()))
        rows = []
        for canonical_id, group in groups.items():
            occurrences = group['occurrences']
            if map_id is not None and not any(item['map_id'] == map_id for item in occurrences):
                continue
            if query and not any(query in f'{item["concept_name"]} {item["description"]} {item["map_title"]}'.casefold()
                                 for item in occurrences):
                continue
            selected = next((item for item in occurrences if item['map_id'] == map_id), None)
            visible = [item for item in ([selected] if selected else occurrences)
                       if item['level'] != 'unknown']
            if not visible:
                continue
            representative = max(visible, key=lambda item: item['last_assessed_at'] or '')
            levels = {item['level'] for item in visible}
            confidence_levels = {item['confidence_level'] for item in visible}
            sources = {item['source'] for item in visible}
            aliases = sorted({item['concept_name'] for item in occurrences
                              if item['concept_name'] != representative['concept_name']})
            rows.append(dict(canonical_id=canonical_id,
                map_id=representative['map_id'], concept_id=representative['concept_id'],
                concept_name=representative['concept_name'], description=representative['description'],
                path=representative['path'],
                aliases=aliases, map_count=len({item['map_id'] for item in occurrences}),
                assessed_map_count=len({item['map_id'] for item in occurrences
                    if item['level'] != 'unknown'}),
                level=next(iter(levels)) if len(levels) == 1 else 'mixed',
                confidence_level=next(iter(confidence_levels)) if len(confidence_levels) == 1 else 'mixed',
                source=next(iter(sources)) if len(sources) == 1 else 'multiple_maps',
                question_answers=selected['direct_question_answers'] if selected else len(group['evidence_ids']),
                last_assessed_at=(selected['last_assessed_at'] if selected else
                    max((item['last_assessed_at'] or '' for item in occurrences), default='') or None),
                map_results=sorted(occurrences, key=lambda item: item['map_title'].casefold())))
        counts = {name: sum(row['level'] == name for row in rows)
                  for name in ('high', 'medium', 'low', 'unknown', 'mixed')}
        counts['all'] = len(rows)
        if level != 'all':
            rows = [row for row in rows if row['level'] == level]
        rows.sort(key=lambda row: row['concept_name'].casefold())
        if sort == 'priority':
            rank = {'low': 0, 'mixed': 1, 'unknown': 2, 'medium': 3, 'high': 4}
            rows.sort(key=lambda row: rank[row['level']])
        elif sort == 'understood':
            rank = {'high': 0, 'medium': 1, 'mixed': 2, 'low': 3, 'unknown': 4}
            rows.sort(key=lambda row: rank[row['level']])
        elif sort == 'recent':
            rows.sort(key=lambda row: row['last_assessed_at'] or '', reverse=True)
        elif sort == 'questions':
            rows.sort(key=lambda row: row['question_answers'], reverse=True)
        total = len(rows)
        start = (page - 1) * page_size
        return dict(items=rows[start:start + page_size], total=total, page=page,
            page_size=page_size, counts=counts,
            maps=[dict(map_id=item['map_id'], title=item['title']) for item in maps])

    def knowledge_node(self, map_id, concept_id, user_id=None):
        item = self.repo.get_map(map_id)
        session = self.repo.get(map_id)
        node = find(session, concept_id)
        if node is None or node.depth == 0:
            raise KeyError(concept_id)
        parent = {child.concept_id: current.concept_id
                  for current in walk(session.knowledge_tree) for child in current.child_nodes}
        names = {current.concept_id: current.concept_name for current in walk(session.knowledge_tree)}
        path = []
        cursor = node.concept_id
        while cursor in names:
            path.append(names[cursor])
            cursor = parent.get(cursor)
        refs = self.repo.canonical_refs(map_id).get(node.concept_id, {})
        visible_ids = self._owned_map_ids(user_id) if user_id is not None else None
        map_titles = {known['map_id']: known['title'] for known in self.repo.list_maps()
                      if visible_ids is None or known['map_id'] in visible_ids}
        survey = session.self_assessments.get(node.concept_id)
        return dict(map_id=map_id, map_title=item['title'], concept_id=node.concept_id,
            concept_name=node.concept_name, description=node.description,
            path=list(reversed(path)), assessment_targets=[target.model_dump() for target in node.assessment_targets],
            understanding=summaries(session)[node.concept_id],
            self_assessment=survey.model_dump() if survey else None,
            conversation_evidence=[public_observation(event) for event in session.chat.observations if event.concept_id == node.concept_id],
            other_maps=[dict(map_id=other, title=map_titles.get(other, other))
                        for other in refs.get('other_maps', [])
                        if visible_ids is None or other in visible_ids],
            history=[event for event in self.history(map_id)
                     if event['concept_id'] == node.concept_id and event['type'] == 'question'])

    def history(self, map_id):
        session = self.repo.get(map_id)
        nodes = {node.concept_id: node for node in walk(session.knowledge_tree)}
        questions = {item.question_id: item for item in session.questions}
        items = []
        for evidence in session.evidence:
            question = questions.get(evidence.question_id)
            node = nodes.get(evidence.concept_id)
            if not question or not node:
                continue
            target = next((item.description for item in node.assessment_targets
                           if item.target_id == evidence.assessment_target_id), '')
            items.append(dict(type='question', at=evidence.answered_at or session.created_at,
                map_id=map_id, concept_id=node.concept_id, concept_name=node.concept_name,
                question=question.question_text, user_answer=next((choice.text for choice in
                    question.choices or [] if choice.choice_id == evidence.user_answer), evidence.user_answer),
                result=evidence.correctness, target=target,
                correct_answer=', '.join(next((choice.text for choice in question.choices or []
                    if choice.choice_id == answer), answer) for answer in question.expected_answer),
                answer_explanation=question.answer_explanation,
                demonstrated_knowledge=evidence.demonstrated_knowledge,
                missing_knowledge=evidence.missing_knowledge,
                understanding_before=evidence.understanding_before,
                understanding_after=evidence.understanding_after,
                origin_map_id=evidence.origin_map_id))
        for concept_id, survey in session.self_assessments.items():
            node = nodes.get(concept_id)
            if node:
                items.append(dict(type='self_assessment', at=survey.answered_at,
                    map_id=map_id, concept_id=concept_id, concept_name=node.concept_name,
                    level=survey.level, origin_map_id=survey.origin_map_id))
        return sorted(items, key=lambda item: item['at'], reverse=True)
