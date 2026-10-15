"""Free conversation streams immediately; durable jobs update multiple graph branches."""
import asyncio
import json
import logging
import re
import time
from app.agents.concept_addition import ConceptAdditionAgent
from app.llm.base import LLMError
from app.llm.telemetry import trace
from app.models.chat import ChatAssessment, ChatConversation, ChatInput, ChatMessage, ChatObservation, ChatJob
from app.models.domain import AdditionInput, uid
from app.policies.conversation import assessed_ids, PROVISIONAL_CREATION_REASON
from app.policies.understanding import summaries
from app.repositories.sessions import ConflictError
from app.services.diagnostic import find, spec, walk
from app.services.chat_map import ChatMapProcessor, split_text
from app.services.chat_queue import ChatEvidenceQueue

logger = logging.getLogger(__name__)


class ChatService:
    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        self.repo = diagnostic.repo
        self.settings = diagnostic.settings
        self.foreground = {}
        self.background = {}
        self.background_limit = asyncio.Semaphore(self.settings.chat_background_concurrency)
        self.work_limit = asyncio.Semaphore(self.settings.chat_processing_concurrency)
        self.processor = ChatMapProcessor(self)
        self.evidence_queue = ChatEvidenceQueue(self)
        self.closed = False
        self.cancelled_maps = set()
        self.diagnostic.on_graph_change = self.graph_changed

    def request_reconciliation(self, session_id):
        def change(session):
            session.chat.reconciliation_requested = True
            session.chat.background_status = 'queued'
        self.mutate(session_id, change)

    def graph_changed(self, session_id, concept_ids=()):
        if self.closed or session_id in self.cancelled_maps:
            return
        try:
            session = self.repo.get(session_id)
            if session.complete or not session.chat.experience_units:
                return
            def change(current):
                current.chat.pending_node_ids = sorted(set(current.chat.pending_node_ids) | set(concept_ids))
                current.chat.failed_node_ids = [identifier for identifier in current.chat.failed_node_ids if identifier not in concept_ids]
                current.chat.reconciliation_requested = True
                if current.chat.background_status != 'failed':
                    current.chat.background_status = 'queued'
            self.mutate(session_id, change)
            self.schedule_background(session_id)
        except KeyError:
            return

    def mutate(self, session_id, change):
        for attempt in range(4):
            session = self.repo.get(session_id)
            change(session)
            from app.services.concept_deletion import prune_deleted
            prune_deleted(session)
            try:
                self.repo.save(session)
                return session
            except ConflictError:
                if attempt == 3:
                    raise

    async def generate(self, session_id, turn_id, agent, payload, schema):
        session = self.repo.get(session_id)
        role = 'recorder' if agent in ('chat_extract', 'chat_structure', 'chat_structure_review') else 'evaluation'
        sender = 'reception' if agent == 'chat_extract' else 'recorder' if agent == 'chat_assessment' else None
        async with self.diagnostic.jobs.track(session_id, role, session.chat.focus_concept_id, agent, from_role=sender):
            with trace(session_id=session_id, chat_turn_id=turn_id):
                return await self.diagnostic.providers[session.mode].generate(agent, payload, schema, .1)

    def reprocess(self, session_id):
        self.cancelled_maps.discard(session_id)
        running = self.background.get(session_id)
        def enqueue(session):
            if session.complete:
                raise ValueError('進行中の深掘りマップで会話してください。')
            known = {job.turn_id for job in session.chat.jobs}
            for message in session.chat.messages:
                if message.role == 'user' and message.status == 'complete' and message.message_id not in known:
                    session.chat.jobs.append(ChatJob(turn_id=message.message_id))
                    known.add(message.message_id)
            for job in session.chat.jobs:
                if job.status == 'failed' or (job.status == 'running' and (not running or running.done())):
                    job.status, job.error = 'queued', None
            if any(job.status == 'queued' for job in session.chat.jobs):
                session.chat.background_status, session.chat.background_error = 'queued', None
            if session.chat.experience_units:
                session.chat.failed_node_ids = []
                session.chat.reconciliation_requested = True
                session.chat.background_status, session.chat.background_error = 'queued', None
                for item in session.chat.evidence_queue:
                    if item.status not in ('resolved', 'ignored'):
                        item.last_checked_graph = ''
        session = self.mutate(session_id, enqueue)
        if any(job.status == 'queued' for job in session.chat.jobs) or session.chat.reconciliation_requested:
            self.schedule_background(session_id)
        return self.diagnostic.public(session)

    def new_conversation(self, session_id, request):
        def change(session):
            if session.complete or session.manual_flow != 'decomposition_first' or session.exploration_mode != 'manual':
                raise ValueError('進行中の深掘りマップで会話してください。')
            if any(item.conversation_id == request.conversation_id for item in session.chat.conversations):
                return  # 再送されても空の会話を増やさない。
            running = self.foreground.get(session_id)
            if session.chat.foreground_turn_id or (running and not running.done()):
                raise ConflictError('返答を生成中です。完了してから新しい会話を始めてください。')
            session.chat.conversations.append(ChatConversation(conversation_id=request.conversation_id,
                title=f'会話{len(session.chat.conversations)+1}'))
            session.chat.current_conversation_id = request.conversation_id
            session.chat.focus_concept_id = None
            session.chat.conversation_guidance = ''
        return self.diagnostic.public(self.mutate(session_id, change))

    def related_experiences(self, session, turn_id, concepts, conversation_id=None):
        end = next(index for index, item in enumerate(session.chat.messages) if item.message_id == turn_id)
        allowed = {item.message_id for item in session.chat.messages[:end+1] if item.role == 'user'
                   and (conversation_id is None or item.conversation_id == conversation_id)}
        body = ' '.join(node['concept_name']+' '+node['description'] for node in concepts).casefold()
        grams = {body[index:index+2] for index in range(len(body)-1)}
        units = [unit for unit in session.chat.experience_units if unit.turn_id in allowed]
        units.sort(key=lambda unit: sum(gram in (unit.topic+' '+unit.statement).casefold() for gram in grams), reverse=True)
        return units[:40]

    def evidence_input(self, session, turn_id, units, concepts, purpose='evidence'):
        # Excerpts retain original message IDs. Validation checks both these
        # excerpts and the full original text, rejecting fabricated joined quotes.
        quotes = {}
        for unit in units:
            for ref in unit.citations:
                quotes.setdefault(ref.message_id, []).append(ref.quote)
        messages = [item.model_copy(update={'content': '\n\n'.join(dict.fromkeys(quotes[item.message_id]))})
                    for item in session.chat.messages if item.role == 'user' and item.message_id in quotes]
        return ChatInput(theme=session.theme, domain_context=session.domain_context, messages=messages,
                         concepts=concepts, experience_units=units, purpose=purpose,
                         focus_concept_id=session.chat.focus_concept_id,
                         previous_guidance=session.chat.conversation_guidance)

    def public(self, session_id):
        session = self.repo.get(session_id)
        # Background tasks are process-local. Recover interrupted work after a restart.
        if session.chat.foreground_turn_id and session_id not in self.foreground:
            def recover(current):
                for message in current.chat.messages:
                    if message.status == 'pending':
                        message.status = 'failed'
                current.chat.foreground_turn_id = None
            session = self.mutate(session_id, recover)
        if (not session.complete and (session.chat.background_status in ('queued', 'running') or
                session.chat.reconciliation_requested or session.chat.pending_node_ids) and
                session.chat.background_status != 'failed' and
                (session_id not in self.background or self.background[session_id].done())):
            self.reprocess(session_id)
            session = self.repo.get(session_id)
        return self.diagnostic.public(session)

    def exploration_topics(self, session, text):
        """Suggest optional broad topics; do not turn unknown targets into a quiz."""
        observations = {item.concept_id for item in session.chat.observations}
        topics = []
        grams = {text[index:index+2] for index in range(len(text)-1) if text[index:index+2].strip()}
        for branch in session.knowledge_tree.child_nodes:
            nodes = list(walk(branch))
            covered = sum(node.concept_id in observations or node.concept_id in session.self_assessments
                          or any(item.concept_id == node.concept_id for item in session.evidence) for node in nodes)
            topics.append(dict(concept_id=branch.concept_id, name=branch.concept_name,
                               description=branch.description, explored_count=covered, node_count=len(nodes),
                               depth=max(node.depth for node in nodes) - branch.depth,
                               relevance=sum(gram in (branch.concept_name + branch.description) for gram in grams)))
        topics.sort(key=lambda item: (item['explored_count']/item['node_count'], item['depth'], -item['relevance']))
        return [{key: value for key, value in topic.items() if key != 'relevance'} for topic in topics[:3]]

    def concepts(self, session, text, selected=None, only_ids=None, prioritize_focus=True):
        selected = (selected or session.chat.focus_concept_id) if prioritize_focus else None
        nodes = [node for node in walk(session.knowledge_tree) if node.depth > 0]
        if only_ids is not None:
            nodes = [node for node in nodes if node.concept_id in only_ids]
        else:
            words = set(re.findall(r'[A-Za-z0-9]+', text.casefold()))
            grams = {text[index:index+2] for index in range(len(text)-1) if text[index:index+2].strip()}
            def rank(node):
                body = (node.concept_name + ' ' + node.description + ' ' + ' '.join(t.description for t in node.assessment_targets)).casefold()
                relevance = sum(word in body for word in words) * 3 + sum(gram in body for gram in grams)
                return (node.concept_id == selected, node.parent_concept_id == selected, relevance, prioritize_focus and node.concept_id == session.chat.focus_concept_id,
                        not any(item.concept_id == node.concept_id for item in session.chat.observations), -node.depth)
            nodes.sort(key=rank, reverse=True)
            nodes = nodes[:self.settings.chat_context_nodes]
        summary = summaries(session)
        result = []
        for node in nodes:
            path = []
            parent = node
            seen = set()
            while parent and parent.concept_id not in seen:
                seen.add(parent.concept_id)
                path.insert(0, parent.concept_name)
                parent = find(session, parent.parent_concept_id) if parent.parent_concept_id else None
            result.append({**spec(node).model_dump(), 'path': path, 'depth': node.depth,
                'has_children': bool(node.child_nodes or any(e.source == node.concept_id and e.relation == 'part' for e in session.concept_edges)),
                'estimate': summary[node.concept_id],
                'previous_observations': [item.model_dump() for item in session.chat.observations
                    if item.concept_id == node.concept_id][-3:]})
        return result

    def input(self, session, turn_id, selected=None, only_ids=None, purpose='current_turn', assessment=None):
        user_index = next(index for index, item in enumerate(session.chat.messages) if item.message_id == turn_id)
        # Never let a newer message influence a job that belongs to an older turn.
        end = user_index + 1
        messages = [item for item in session.chat.messages[max(0, end-self.settings.chat_history_messages):end]
                    if item.status == 'complete']
        conversation_id = session.chat.messages[user_index].conversation_id
        if purpose == 'reply':
            messages = [item for item in messages if item.conversation_id == conversation_id]
        text = session.chat.messages[user_index].content
        if purpose == 'new_nodes':
            query = ' '.join(node.concept_name + ' ' + node.description for node in walk(session.knowledge_tree)
                             if node.concept_id in (only_ids or set())).casefold()
            grams = {query[index:index+2] for index in range(len(query)-1)}
            old_users = [item for item in session.chat.messages[:end] if item.role == 'user' and item.status == 'complete']
            old_users.sort(key=lambda item: sum(gram in item.content.casefold() for gram in grams), reverse=True)
            selected_ids = {item.message_id for item in messages[-self.settings.chat_history_messages//2:]}
            selected_ids.update(item.message_id for item in old_users[:self.settings.chat_history_messages//2])
            messages = [item for item in session.chat.messages[:end] if item.message_id in selected_ids and item.status == 'complete']
        # 原文は保存したまま、最新の発言を省略せず古い履歴から外す。
        # 長文を繰り返した場合も、メッセージ件数だけで入力が膨らまないようにする。
        bounded_messages = []
        remaining = self.settings.chat_history_chars
        for message in reversed(messages):
            if len(message.content) > remaining:
                break
            bounded_messages.append(message)
            remaining -= len(message.content)
        messages = list(reversed(bounded_messages))
        concepts = self.concepts(session, text, selected, only_ids)
        if purpose == 'reply':
            turn_ids = {item.message_id for item in session.chat.messages[:end]
                        if item.conversation_id == conversation_id}
            for node in concepts:
                node['previous_observations'] = [item for item in node['previous_observations']
                    if all(ref['message_id'] in turn_ids for ref in item['citations'])]
        return ChatInput(theme=session.theme, domain_context=session.domain_context,
            messages=messages, concepts=concepts,
            focus_concept_id=selected or session.chat.focus_concept_id,
            previous_guidance=session.chat.conversation_guidance,
            assessment=assessment, purpose=purpose,
            experience_units=self.related_experiences(session, turn_id, concepts,
                conversation_id=conversation_id if purpose == 'reply' else None),
            exploration_topics=self.exploration_topics(session, text) if purpose == 'reply' else [],
            processing_topics=list(dict.fromkeys(title for job in session.chat.jobs if job.status in ('queued', 'running')
                for message in session.chat.messages if message.message_id == job.turn_id
                and (purpose != 'reply' or message.conversation_id == conversation_id)
                for _, section in split_text(message.content, self.settings.chat_chunk_chars) for title in section))[:20])

    def valid_citations(self, citations, messages):
        users = {item.message_id: item.content for item in messages if item.role == 'user' and item.status == 'complete'}
        return all(ref.message_id in users and ref.quote in users[ref.message_id] for ref in citations)

    def persist_assessment(self, session_id, turn_id, assessment, context):
        allowed = {item['concept_id']: {target['target_id'] for target in item['assessment_targets']} for item in context.concepts}
        expected = {item['concept_id']: item for item in context.concepts}
        def change(session):
            for judgment in assessment.judgments:
                node = find(session, judgment.concept_id)
                if (judgment.target_id not in allowed.get(judgment.concept_id, set()) or node is None
                        or judgment.target_id not in {target.target_id for target in node.assessment_targets}
                        or not self.valid_citations(judgment.citations, context.messages)
                        or not self.valid_citations(judgment.citations, session.chat.messages)):
                    logger.warning('chat_judgment_skipped session_id=%s reason=invalid_reference', session_id)
                    continue
                if any(node.model_dump()[field] != expected[judgment.concept_id][field]
                       for field in ('concept_name', 'description', 'assessment_targets')):
                    raise ConflictError('判定対象が更新されたため再判定します。')
                # The current-turn judgment must actually cite this turn.
                if context.purpose == 'current_turn' and not any(ref.message_id == turn_id for ref in judgment.citations):
                    continue
                payload = judgment.model_dump()
                supporting = [unit for unit in context.experience_units if any(
                    ref.message_id == source.message_id and ref.quote in source.quote
                    for ref in judgment.citations for source in unit.citations)]
                if context.unit_concept_ids and any(not any(
                        judgment.concept_id in context.unit_concept_ids.get(unit.unit_id, [])
                        and any(source.message_id == ref.message_id and ref.quote in source.quote
                                for source in unit.citations) for unit in supporting) for ref in judgment.citations):
                    logger.warning('chat_judgment_skipped session_id=%s reason=unlinked_evidence', session_id)
                    continue
                if supporting and all(unit.kind == 'mention' for unit in supporting):
                    continue
                if supporting and all(unit.kind in ('experience', 'mention') for unit in supporting):
                    payload['kind'] = 'self_report'
                    # Experience without a stated gap is neutral, not evidence of
                    # inability. Keep it in the medium band with low confidence.
                    payload['score'] = min(max(judgment.score, .5), .6)
                    payload['reason'] = '経験の申告に基づく暫定評価。' + judgment.reason[:970]
                if payload['kind'] == 'self_report':
                    payload['confidence'] = min(judgment.confidence, .25)
                key = (node.concept_id, judgment.target_id, tuple(sorted((ref.message_id, ref.quote) for ref in judgment.citations)))
                if any((item.concept_id, item.target_id, tuple(sorted((ref.message_id, ref.quote) for ref in item.citations))) == key
                       and item.score == payload['score'] and item.kind == payload['kind']
                       for item in session.chat.observations):
                    continue
                session.chat.observations = [item for item in session.chat.observations
                    if not (item.concept_id == node.concept_id and item.reason == PROVISIONAL_CREATION_REASON)]
                session.chat.observations.append(ChatObservation(**payload, turn_id=turn_id))
            turn = next((item for item in session.chat.messages if item.message_id == turn_id), None)
            if (context.purpose in ('current_turn', 'evidence') and
                    (turn is None or turn.conversation_id == session.chat.current_conversation_id) and
                    all(message.conversation_id == session.chat.current_conversation_id for message in context.messages)):
                chosen = assessment.focus_concept_id
                if chosen in allowed and find(session, chosen):
                    session.chat.focus_concept_id = chosen
                else:
                    session.chat.focus_concept_id = next(iter(allowed), None)
                session.chat.conversation_guidance = assessment.conversation_guidance
        return self.mutate(session_id, change)

    def expansion_candidates(self, session):
        # Use validated, concrete user evidence rather than the model's optional
        # structure_needed flag. A confidence-only self report does not open a branch.
        assessed = assessed_ids(session)
        nodes = [node for node in walk(session.knowledge_tree)
                 if node.concept_id in assessed and self.diagnostic.can_expand(session, node)]
        nodes.sort(key=lambda node: (node.concept_id != session.chat.focus_concept_id, node.depth))
        return nodes

    def prepare_assessed_branches(self, session):
        # Prepare only the next layer. Cached children stay hidden until opened,
        # so history-based judgments cannot recursively generate an entire tree.
        self.diagnostic.schedule_prefetch(session, self.expansion_candidates(session),
                                          allow_beyond_initial=True)

    async def begin(self, session_id, request):
        session = self.repo.get(session_id)
        if session.complete or session.manual_flow != 'decomposition_first' or session.exploration_mode != 'manual':
            raise ValueError('進行中の深掘りマップで会話してください。')
        if request.concept_id and find(session, request.concept_id) is None:
            raise KeyError(request.concept_id)
        existing = next((item for item in session.chat.messages if item.message_id == request.message_id), None)
        conversation_id = request.conversation_id or session.chat.current_conversation_id
        if (conversation_id != session.chat.current_conversation_id or
                (existing and existing.conversation_id != conversation_id)):
            raise ConflictError('会話が切り替わっています。現在の会話を開いて送信してください。')
        if existing and (existing.role != 'user' or existing.content != request.content):
            raise ValueError('送信IDが別の発言に使用されています。')
        reply_id = request.message_id + '_reply'
        if existing:
            reply = next((item for item in session.chat.messages if item.message_id == reply_id), None)
            if reply and reply.status == 'complete':
                async def replay():
                    yield self.event('complete', {'session': self.diagnostic.public(session)})
                return replay()
        running = self.foreground.get(session_id)
        if (running and not running.done()) or session.chat.foreground_turn_id:
            raise ConflictError('返答を生成中です。完了してから送信してください。')
        def reserve(current):
            if current.chat.current_conversation_id != conversation_id:
                raise ConflictError('会話が切り替わっています。現在の会話を開いて送信してください。')
            if current.chat.foreground_turn_id:
                raise ConflictError('返答を生成中です。')
            if not existing:
                first = not any(item.role == 'user' and item.conversation_id == conversation_id
                                for item in current.chat.messages)
                current.chat.messages.append(ChatMessage(message_id=request.message_id, role='user', content=request.content,
                                                         conversation_id=conversation_id))
                current.chat.messages.append(ChatMessage(message_id=reply_id, role='assistant', content='', status='pending',
                                                         conversation_id=conversation_id))
                if first:
                    conversation = next(item for item in current.chat.conversations if item.conversation_id == conversation_id)
                    conversation.title = request.content.splitlines()[0][:40]
            else:
                reply = next(item for item in current.chat.messages if item.message_id == reply_id)
                reply.content, reply.status = '', 'pending'
            current.chat.foreground_turn_id = request.message_id
        self.mutate(session_id, reserve)
        self.reprocess(session_id)
        queue = asyncio.Queue()
        task = asyncio.create_task(self.run(session_id, request, reply_id, queue))
        self.foreground[session_id] = task
        task.add_done_callback(lambda finished: self.foreground.pop(session_id, None) if self.foreground.get(session_id) is finished else None)
        async def stream():
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ': heartbeat\n\n'
                    continue
                if event is None:
                    return
                yield event
        return stream()

    @staticmethod
    def event(name, payload):
        return f'event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n'

    async def run(self, session_id, request, reply_id, queue):
        started = time.monotonic()
        reply_text = ''
        first_token = None
        try:
            await queue.put(self.event('phase', {'phase': 'replying'}))
            session = self.repo.get(session_id)
            provider = self.diagnostic.providers[session.mode]
            # The speaker uses a snapshot of what is already known; extraction,
            # placement, and assessment never block the first reply token.
            reply_input = self.input(session, request.message_id, request.concept_id, purpose='reply')
            allowed = {node['concept_id'] for node in reply_input.concepts}
            conversation_messages = {message.message_id for message in session.chat.messages
                                     if message.conversation_id == session.chat.current_conversation_id}
            reply_input.assessment = ChatAssessment(
                judgments=[item for item in session.chat.observations if item.concept_id in allowed and
                    all(ref.message_id in conversation_messages for ref in item.citations)][-24:],
                focus_concept_id=session.chat.focus_concept_id,
                conversation_guidance=session.chat.conversation_guidance)
            async with self.diagnostic.jobs.track(session_id, 'reception', request.concept_id, 'chat_reply',
                                                 from_role='recorder' if reply_input.experience_units else None):
                with trace(session_id=session_id, chat_turn_id=request.message_id):
                    async for delta in provider.stream_text('chat_reply', reply_input, .5):
                        if first_token is None:
                            first_token = time.monotonic()
                        reply_text += delta
                        await queue.put(self.event('delta', {'message_id': reply_id, 'text': delta}))
            if not reply_text.strip():
                raise LLMError('返答を生成できませんでした。同じ発言を再送できます。')
            def finish(current):
                reply = next(item for item in current.chat.messages if item.message_id == reply_id)
                reply.content, reply.status = reply_text, 'complete'
                current.chat.foreground_turn_id = None
                current.chat.timings.update(assessment_ms=0, first_text_ms=round((first_token-started)*1000),
                                            reply_ms=round((time.monotonic()-started)*1000))
            session = self.mutate(session_id, finish)
            await queue.put(self.event('complete', {'session': self.diagnostic.public(session)}))
            logger.info('chat_turn_complete session_id=%s timings=%s', session_id, session.chat.timings)
        except asyncio.CancelledError:
            self.fail_reply(session_id, reply_id, reply_text)
            raise
        except Exception as exc:
            message = str(exc) if isinstance(exc, (LLMError, ValueError, ConflictError)) else '会話の処理に失敗しました。同じ発言を再送できます。'
            logger.warning('chat_turn_failed session_id=%s error_type=%s', session_id, type(exc).__name__)
            try:
                session = self.fail_reply(session_id, reply_id, reply_text)
                await queue.put(self.event('error', {'message': message, 'session': self.diagnostic.public(session)}))
            except KeyError:
                await queue.put(self.event('error', {'message': message}))
        finally:
            await queue.put(None)

    def fail_reply(self, session_id, reply_id, content):
        def change(session):
            for item in session.chat.messages:
                if item.message_id == reply_id:
                    item.content, item.status = content, 'failed'
            session.chat.foreground_turn_id = None
        return self.mutate(session_id, change)

    def schedule_background(self, session_id):
        if session_id in self.background and not self.background[session_id].done():
            return
        if any(job.status == 'running' for job in self.repo.get(session_id).chat.jobs):
            def recover(current):
                for job in current.chat.jobs:
                    if job.status == 'running':
                        job.status = 'queued'
            self.mutate(session_id, recover)
        task = asyncio.create_task(self.run_background(session_id))
        self.background[session_id] = task
        task.add_done_callback(lambda finished: self.background.pop(session_id, None) if self.background.get(session_id) is finished else None)

    @staticmethod
    def fail_background(session, message):
        session.chat.background_status = 'failed'
        session.chat.background_error = message
        session.chat.generating_concept_ids = []
        session.chat.reconciliation_phase = 'idle'
        for job in session.chat.jobs:
            if job.status in ('queued', 'running'):
                job.status, job.error = 'failed', message

    async def run_background(self, session_id):
        while True:
            session = self.repo.get(session_id)
            pending = next((job for job in session.chat.jobs if job.status == 'queued'), None)
            if pending is None:
                failed = any(job.status == 'failed' for job in session.chat.jobs)
                if (not session.complete and any(job.status == 'complete' or job.completed_chunks for job in session.chat.jobs) and
                        (session.chat.reconciliation_requested or
                         set(session.chat.pending_node_ids) - set(session.chat.failed_node_ids))):
                    try:
                        self.mutate(session_id, lambda current: setattr(current.chat, 'background_status', 'running'))
                        async with self.background_limit:
                            await self.evidence_queue.reconcile(session_id)
                    except asyncio.CancelledError:
                        self.mutate(session_id, lambda current: self.fail_background(current,
                            '処理が中断されました。保存済みの情報から再試行できます。'))
                        raise
                    except Exception as exc:
                        logger.warning('chat_reconciliation_failed session_id=%s error_type=%s', session_id, type(exc).__name__)
                        def fail_reconciliation(current):
                            current.chat.reconciliation_requested = True
                            current.chat.background_status = 'failed'
                            current.chat.background_error = '会話と新しい項目の照合に失敗しました。保存済みの情報から再試行できます。'
                            current.chat.reconciliation_phase = 'idle'
                        self.mutate(session_id, fail_reconciliation)
                        return
                    continue
                tasks = self.diagnostic.generation_tasks(session_id)
                if not session.complete and not failed and tasks and any(item.status in ('pending', 'waiting') for item in session.chat.evidence_queue):
                    def waiting(current):
                        current.chat.background_status = 'running'
                        current.chat.reconciliation_phase = 'waiting'
                    self.mutate(session_id, waiting)
                    # Cancellation must not propagate into a user's decomposition.
                    try:
                        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    except asyncio.CancelledError:
                        self.mutate(session_id, lambda current: self.fail_background(current,
                            '処理が中断されました。保存済みの情報から再試行できます。'))
                        raise
                    self.request_reconciliation(session_id)
                    continue
                def finish(current):
                    failed_job = next((job for job in reversed(current.chat.jobs) if job.status == 'failed'), None)
                    current.chat.background_status = 'failed' if failed_job or current.chat.failed_node_ids else 'idle'
                    current.chat.background_error = failed_job.error if failed_job else (
                        '一部の新しい項目を判定できませんでした。保存済みの情報から再試行できます。'
                        if current.chat.failed_node_ids else None)
                    current.chat.generating_concept_ids = []
                    current.chat.reconciliation_phase = 'idle'
                self.mutate(session_id, finish)
                return
            turn_id = pending.turn_id
            started = time.monotonic()
            try:
                async with self.background_limit:
                    def mark_running(current):
                        job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
                        job.status = 'running'
                        current.chat.background_turn_id = turn_id
                        current.chat.background_status = 'running'
                    self.mutate(session_id, mark_running)
                    await self.process_structure(session_id, turn_id)
                def complete(current):
                    job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
                    partial = bool(job.failed_unit_ids or len(job.completed_chunks) < job.total_chunks)
                    job.status, job.phase = ('failed' if partial else 'complete'), 'complete'
                    job.error = 'マップの一部を反映できませんでした。保存済みの更新から再試行できます。' if partial else None
                    current.chat.timings['background_ms'] = round((time.monotonic()-started)*1000)
                self.mutate(session_id, complete)
            except asyncio.CancelledError:
                try:
                    self.mutate(session_id, lambda current: self.fail_background(current, '処理が中断されました。保存済みの更新から再試行できます。'))
                except KeyError:
                    pass
                raise
            except Exception as exc:
                logger.warning('chat_background_failed session_id=%s turn_id=%s error_type=%s', session_id, turn_id, type(exc).__name__)
                try:
                    def fail(current):
                        job = next(job for job in current.chat.jobs if job.turn_id == turn_id)
                        job.status = 'failed'
                        job.error = 'マップの一部を反映できませんでした。保存済みの更新から再試行できます。'
                        current.chat.generating_concept_ids = []
                    self.mutate(session_id, fail)
                except KeyError:
                    return

    async def process_structure(self, session_id, turn_id):
        if not self.repo.get(session_id).complete:
            await self.processor.process(session_id, turn_id)

    async def add_node(self, session_id, addition, generated=None):
        session = self.repo.get(session_id)
        parent = find(session, addition.parent_concept_id)
        if parent is None or session.complete:
            return
        existing = next((node for node in walk(session.knowledge_tree)
                         if node.concept_name.casefold() == addition.concept_name.casefold()), None)
        if existing:
            return existing.concept_id
        concept_id = uid('chat')
        request = AdditionInput(concept_id=concept_id, concept_name=addition.concept_name,
            note=addition.reason, parent_concept=spec(parent), siblings=[spec(child) for child in parent.child_nodes],
            domain_context=session.domain_context, target_depth=parent.depth+1,
            existing_concept_ids=[node.concept_id for node in walk(session.knowledge_tree)])
        if generated is None:
            async with self.diagnostic.jobs.track(session_id, 'miner', parent.concept_id, 'chat_addition', from_role='recorder'):
                with trace(session_id=session_id, concept_id=parent.concept_id):
                    generated = await ConceptAdditionAgent(self.diagnostic.providers[session.mode]).run(request)
        for attempt in range(3):
            if self.diagnostic.generation_tasks(session_id):
                self.request_reconciliation(session_id)
                return
            latest = self.repo.get(session_id)
            parent = find(latest, addition.parent_concept_id)
            if parent is None or latest.complete:
                return
            proposal = await self.diagnostic.deduplicator.propose(latest, parent, generated)
            if self.diagnostic.generation_tasks(session_id):
                self.request_reconciliation(session_id)
                return
            from app.services.concept_merge import MergeConflict
            try:
                child = self.diagnostic.deduplicator.apply(latest, parent, generated, proposal,
                    origin='generated', user_note=addition.reason, source='chat')
            except MergeConflict:
                if attempt == 2:
                    self.request_reconciliation(session_id)
                    return
                continue
            try:
                self.repo.save(latest)
                self.diagnostic.schedule_cross_map(session_id, [child.concept_id])
                self.diagnostic.notify_graph_change(session_id, [child.concept_id])
                return child.concept_id
            except ConflictError:
                if attempt == 2:
                    raise

    async def close(self):
        self.closed = True
        self.diagnostic.on_graph_change = None
        tasks = [*self.foreground.values(), *self.background.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.processor.retrieval.close()

    async def cancel(self, session_id):
        self.cancelled_maps.add(session_id)
        tasks = [task for task in (self.foreground.get(session_id), self.background.get(session_id)) if task]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.processor.retrieval.close(session_id)
