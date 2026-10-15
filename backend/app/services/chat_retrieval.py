"""Search each evidence unit independently, then batch only compatible contexts."""
import asyncio
import json
from pathlib import Path
from app.embeddings import concept_text, cosine, text_hash
from app.services.diagnostic import find, spec, walk


GRANULARITY_ORDER = {'domain': 0, 'knowledge': 1, 'specific': 2}


def unit_order(unit):
    return GRANULARITY_ORDER[unit.granularity], unit.source_chunk, unit.source_order, unit.unit_id


class ChatRetrieval:
    def __init__(self, chat):
        self.chat, self.repo = chat, chat.repo
        self._vectors = {}

    async def vector(self, session, key, content):
        provider = self.chat.diagnostic.deduplicator.embeddings[session.mode]
        digest = text_hash(content)
        cached = self.repo.get_embedding(session.session_id, key, provider.model, digest)
        if cached is not None:
            return cached
        task_key = session.session_id, key, provider.model, digest
        if task_key not in self._vectors:
            async def calculate():
                async with self.chat.work_limit:
                    result = await provider.embed(content)
                self.repo.save_embedding(session.session_id, key, provider.model, digest, result)
                return result
            self._vectors[task_key] = asyncio.create_task(calculate())
        task = self._vectors[task_key]
        try:
            return await asyncio.shield(task)
        finally:
            if task.done():
                self._vectors.pop(task_key, None)

    def documents(self, session):
        documents = {}
        for node in walk(session.knowledge_tree):
            if node.depth == 0:
                continue
            parent = find(session, node.parent_concept_id) if node.parent_concept_id else None
            documents[node.concept_id] = dict(concept=spec(node), parent_id=node.parent_concept_id,
                parent_name=parent.concept_name if parent else None, prepared=False, embedding_key=node.concept_id)
        prepared_parents = self.repo.ready_prefetch_payloads(session.session_id)
        hashes = self.chat.diagnostic.deduplicator.graph_hashes(session) if prepared_parents else {}
        for parent_id in prepared_parents:
            parent = find(session, parent_id)
            _, prepared = self.repo.get_prefetch(session.session_id, parent_id)
            if parent is None or prepared is None:
                continue
            if (prepared.compared_concept_hashes.get(parent_id) is not None
                    and prepared.compared_concept_hashes[parent_id] != hashes.get(parent_id)):
                continue
            for child in prepared.decomposition.child_nodes:
                key = f'prepared:{parent_id}:{child.concept_id}'
                documents[key] = dict(concept=child.model_copy(update={'concept_id': key}),
                    parent_id=parent_id, parent_name=parent.concept_name, prepared=True, embedding_key=child.concept_id)
        return documents

    async def search(self, session, units):
        documents = self.documents(session)
        keys = list(documents)
        vectors = await asyncio.gather(*(self.vector(session, documents[key]['embedding_key'],
            concept_text(session.theme, documents[key]['concept'], documents[key]['parent_name']))
            for key in keys), return_exceptions=True)
        indexed = [(key, vector) for key, vector in zip(keys, vectors) if not isinstance(vector, BaseException)]
        async def one(unit):
            content = '\n'.join(part for part in (unit.topic, unit.statement, unit.parent_topic) if part)
            vector = await self.vector(session, 'experience:'+unit.unit_id, content)
            if documents and not indexed:
                raise RuntimeError('知識項目の埋め込み検索を準備できませんでした。')
            scores = sorted(((cosine(vector, candidate), key) for key, candidate in indexed), reverse=True)
            return [key for score, key in scores if score >= self.chat.settings.chat_retrieval_min_similarity][
                :self.chat.settings.chat_retrieval_candidates]
        results = await asyncio.gather(*(one(unit) for unit in units), return_exceptions=True)
        return documents, {unit.unit_id: result for unit, result in zip(units, results)}

    def groups(self, units, candidates, limit):
        groups = []
        for unit in sorted(units, key=unit_order):
            ids = set(candidates.get(unit.unit_id, [])[:3])
            placed = False
            for group in groups:
                def compatible(member):
                    member_ids = set(candidates.get(member.unit_id, [])[:3])
                    overlap = len(ids & member_ids) / max(1, min(len(ids), len(member_ids)))
                    return (unit.granularity == member.granularity and bool(ids & member_ids)
                            and overlap >= self.chat.settings.chat_batch_overlap)
                if len(group) < limit and all(compatible(member) for member in group):
                    group.append(unit)
                    placed = True
                    break
            if not placed:
                groups.append([unit])
        return groups

    def context_hash(self, context):
        data = context.model_dump(exclude={'focus_concept_id', 'previous_guidance'})
        for node in data['concepts']:
            for field in ('estimate', 'previous_observations'):
                node.pop(field, None)
        prompts = Path(__file__).resolve().parents[1] / 'prompts'
        policy = self.chat.settings.gemini_model + ''.join((prompts / f'{agent}.txt').read_text(encoding='utf-8')
            for agent in ('chat_structure', 'chat_structure_review'))
        return text_hash(json.dumps(data, sort_keys=True, ensure_ascii=False) + policy)

    async def close(self, session_id=None):
        tasks = [task for key, task in self._vectors.items() if session_id is None or key[0] == session_id]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._vectors = {key: task for key, task in self._vectors.items()
                         if session_id is not None and key[0] != session_id}
