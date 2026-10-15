"""Durable evidence inbox; graph changes retry matching without blocking replies."""
import hashlib
from app.models.chat import EvidenceQueueItem
from app.services.chat_map import addition_key
from app.services.diagnostic import find, walk
from app.services.chat_retrieval import GRANULARITY_ORDER, unit_order


def supports(unit, observation):
    return any(source.message_id == ref.message_id and ref.quote in source.quote
               for source in unit.citations for ref in observation.citations)


class ChatEvidenceQueue:
    def __init__(self, chat):
        self.chat, self.repo = chat, chat.repo

    def ensure(self, session_id):
        def change(session):
            known = {item.unit_id for item in session.chat.evidence_queue}
            for unit in session.chat.experience_units:
                if unit.unit_id not in known:
                    session.chat.evidence_queue.append(EvidenceQueueItem(unit_id=unit.unit_id,
                        status='ignored' if unit.kind == 'mention' else 'pending',
                        reason='用語の言及だけでは判定しません。' if unit.kind == 'mention' else ''))
                    known.add(unit.unit_id)
        return self.chat.mutate(session_id, change)

    def fingerprint(self, session):
        # A session revision also changes for chat progress. Only graph/cache
        # changes warrant another model call for the same unresolved information.
        graph = [node.model_dump_json(exclude={'child_nodes', 'status', 'expansion_error', 'merged_sources'})
                 for node in walk(session.knowledge_tree)]
        graph.extend(f'{edge.source}:{edge.target}:{edge.relation}' for edge in session.concept_edges)
        graph.extend(identifier + ':' + (payload or '') for identifier, payload in
                     self.repo.ready_prefetch_payloads(session.session_id).items())
        return hashlib.sha256('\n'.join(sorted(graph)).encode()).hexdigest()

    def record_links(self, session_id, units, links):
        identifiers = {unit.unit_id for unit in units}
        def change(session):
            for item in session.chat.evidence_queue:
                if item.unit_id not in identifiers or item.status == 'ignored':
                    continue
                related = [link for link in links if link.unit_id == item.unit_id and find(session, link.concept_id)]
                item.matched_concept_ids = sorted({find(session, link.concept_id).concept_id for link in related} |
                    {find(session, identifier).concept_id for identifier in item.added_concept_ids if find(session, identifier)})
                item.detail_concept_ids = sorted({find(session, link.concept_id).concept_id for link in related if link.needs_detail})
                item.status = 'waiting' if item.detail_concept_ids or not item.matched_concept_ids else 'insufficient'
        self.chat.mutate(session_id, change)

    def record_addition(self, session_id, addition, concept_id):
        def change(session):
            units = {unit.unit_id: unit for unit in session.chat.experience_units}
            for item in session.chat.evidence_queue:
                unit = units.get(item.unit_id)
                if not unit or item.status == 'ignored':
                    continue
                if any(source.message_id == ref.message_id and ref.quote in source.quote
                       for source in unit.citations for ref in addition.citations):
                    item.added_concept_ids = sorted(set(item.added_concept_ids) | {concept_id})
                    item.matched_concept_ids = sorted(set(item.matched_concept_ids) | {concept_id})
                    item.detail_concept_ids = []
                    item.pending_addition_keys = [key for key in item.pending_addition_keys if key != addition_key(addition)]
                    item.status = 'insufficient'
        self.chat.mutate(session_id, change)

    def record_candidates(self, session_id, turn_id, units, plan):
        """A passage may require multiple nodes; keep unfinished placements active."""
        sources = {unit.unit_id: unit for unit in units}
        def change(session):
            completed = next(job for job in session.chat.jobs if job.turn_id == turn_id).applied_additions
            for item in session.chat.evidence_queue:
                unit = sources.get(item.unit_id)
                if not unit or item.status == 'ignored':
                    continue
                exact = any(link.unit_id == item.unit_id and not link.needs_detail for link in plan.links)
                item.pending_addition_keys = [] if exact else [addition_key(addition) for addition in plan.additions
                    if addition_key(addition) not in completed and any(
                        source.message_id == ref.message_id and ref.quote in source.quote
                        for source in unit.citations for ref in addition.citations)]
        self.chat.mutate(session_id, change)

    def refresh(self, session_id):
        def change(session):
            units = {unit.unit_id: unit for unit in session.chat.experience_units}
            for item in session.chat.evidence_queue:
                unit = units.get(item.unit_id)
                if not unit or item.status == 'ignored':
                    continue
                item.matched_concept_ids = sorted({find(session, identifier).concept_id for identifier in
                    item.matched_concept_ids if find(session, identifier)})
                evaluated = {event.concept_id for event in session.chat.observations if supports(unit, event)}
                if item.matched_concept_ids and not item.detail_concept_ids and not item.pending_addition_keys:
                    item.status = ('resolved' if set(item.matched_concept_ids) <= evaluated else 'insufficient')
                    item.reason = ('会話の根拠を反映しました。' if item.status == 'resolved'
                                   else '対応する項目はありますが、理解度を判定する根拠が足りません。')
                else:
                    item.status = 'waiting'
                    item.reason = '生成した項目との再照合・適切な配置を待っています。'
        return self.chat.mutate(session_id, change)

    async def reconcile(self, session_id):
        self.ensure(session_id)
        def begin(session):
            session.chat.reconciliation_requested = False
            session.chat.reconciliation_phase = 'assessing'
        session = self.chat.mutate(session_id, begin)
        completed = {job.turn_id for job in session.chat.jobs if job.status == 'complete' or job.completed_chunks}
        turns = [message.message_id for message in session.chat.messages
                 if message.role == 'user' and message.message_id in completed]
        if not turns or session.complete:
            return
        newest = turns[-1]
        pending_ids = set(session.chat.pending_node_ids) - set(session.chat.failed_node_ids)
        if pending_ids:
            # Include processed units as history: later children can be supported
            # by information that already updated an earlier, broader concept.
            present = {node.concept_id for node in walk(session.knowledge_tree)}
            failed = await self.chat.processor.assess(session_id, newest, pending_ids & present) or set()
            self.chat.mutate(session_id, lambda current: setattr(current.chat, 'failed_node_ids',
                sorted(set(current.chat.failed_node_ids) | failed)))
            self.chat.mutate(session_id, lambda current: setattr(current.chat, 'pending_node_ids',
                [identifier for identifier in current.chat.pending_node_ids if identifier not in pending_ids or identifier in failed]))
        session = self.refresh(session_id)
        active = {item.unit_id for item in session.chat.evidence_queue if item.status not in ('resolved', 'ignored')}
        eligible_turns = {unit.turn_id for unit in session.chat.experience_units if unit.unit_id in active}
        for turn_id in turns:
            job = next(job for job in self.repo.get(session_id).chat.jobs if job.turn_id == turn_id)
            if job.pending_expansions and not self.chat.diagnostic.generation_tasks(session_id):
                await self.chat.processor.continue_expansions(session_id, turn_id)
            if turn_id not in eligible_turns:
                continue
            fingerprint = self.fingerprint(self.repo.get(session_id))
            latest = self.repo.get(session_id)
            entries = {item.unit_id: item for item in latest.chat.evidence_queue
                       if item.status not in ('resolved', 'ignored') and
                       (item.last_checked_graph != fingerprint or
                        (not item.last_checked_idle and not self.chat.diagnostic.generation_tasks(session_id)))}
            units = [unit for unit in latest.chat.experience_units if unit.turn_id == turn_id and unit.unit_id in entries]
            if not units:
                continue
            # Broad placements are committed before the next granularity searches
            # the latest graph; this creates useful anchors without an extra planner.
            for granularity in ('domain', 'knowledge', 'specific'):
                batch = sorted([unit for unit in units if unit.granularity == granularity], key=unit_order)
                if not batch:
                    continue
                fingerprint = self.fingerprint(self.repo.get(session_id))
                generating = bool(self.chat.diagnostic.generation_tasks(session_id))
                self.chat.mutate(session_id, lambda current: setattr(current.chat, 'reconciliation_phase', 'matching'))
                plan = await self.chat.processor.route(session_id, turn_id, batch,
                    reconciliation=True, allow_additions=not generating)
                self.record_links(session_id, batch, plan.links)
                if not generating:
                    self.record_candidates(session_id, turn_id, batch, plan)
                await self.chat.processor.assess(session_id, newest, {link.concept_id for link in plan.links})
                latest = self.refresh(session_id)
                checked = {item.unit_id: item for item in latest.chat.evidence_queue}
                unmatched = [unit for unit in batch if checked[unit.unit_id].status == 'waiting'
                    and not checked[unit.unit_id].processing_error
                    and (not checked[unit.unit_id].added_concept_ids or checked[unit.unit_id].pending_addition_keys)]
                additions = [addition for addition in plan.additions if any(
                    source.message_id == ref.message_id and ref.quote in source.quote
                    for unit in unmatched for source in unit.citations for ref in addition.citations)]
                current_fingerprint = self.fingerprint(self.repo.get(session_id))
                if additions and not self.chat.diagnostic.generation_tasks(session_id) and fingerprint == current_fingerprint:
                    self.chat.mutate(session_id, lambda current: setattr(current.chat, 'reconciliation_phase', 'adding'))
                    try:
                        await self.chat.processor.apply_additions(session_id, turn_id, additions)
                    except Exception as exc:
                        current_entries = {item.unit_id: item for item in self.repo.get(session_id).chat.evidence_queue}
                        remaining = [unit for unit in unmatched if not current_entries[unit.unit_id].processing_error]
                        self.chat.processor.fail_units(session_id, turn_id, remaining, exc, stage='addition')
                elif additions and fingerprint != current_fingerprint:
                    self.chat.request_reconciliation(session_id)
                checked_ids = {unit.unit_id for unit in batch}
                checked_idle = not self.chat.diagnostic.generation_tasks(session_id)
                def finish(current):
                    for item in current.chat.evidence_queue:
                        if item.unit_id in checked_ids:
                            item.last_checked_graph = fingerprint
                            item.last_checked_idle = checked_idle
                            if item.status == 'waiting' and not generating:
                                item.status = 'pending'
                                item.reason = '対応先・配置を特定できないため保留しています。'
                self.chat.mutate(session_id, finish)
        self.refresh(session_id)
        def finish_jobs(current):
            for job in current.chat.jobs:
                if job.failed_unit_ids:
                    job.status = 'failed'
                    job.error = 'マップの一部を反映できませんでした。保存済みの更新から再試行できます。'
        self.chat.mutate(session_id, finish_jobs)
