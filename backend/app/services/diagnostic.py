# ==============================================================================
# 診断オーケストレーションサービス (Diagnostic Service)
# 用途: 診断セッションライフサイクル管理（開始、出題、解答評価、深掘り、先読みキャッシュ、コスト追跡）
# ==============================================================================
import asyncio
from app.services.agent_jobs import AgentJobs, tracked, progress_sink, current_job_id
from app.services.concept_deletion import prune_deleted
import logging
import time
from datetime import datetime, timezone
from app.models.domain import *
from app.agents.knowledge_decomposition import DecompositionAgent
from app.agents.question_generation import QuestionAgent
from app.agents.answer_evaluation import EvaluationAgent
from app.services.concept_merge import ConceptDeduplicator, MergeConflict
from app.embeddings import GoogleEmbeddingProvider, DemoEmbeddingProvider
from app.config import Settings
from app.policies.conversation import (assessed_ids as conversation_assessed_ids,
    learning_states as conversation_learning_states, public_observation)
from app.repositories.sessions import ConflictError
from app.llm.base import LLMError
from app.llm.telemetry import trace, register_usage_handler
from app.policies.learning_state import update
from app.policies.understanding import summaries
from app.policies.diagnostic import decide, question_plan
from app.services.cost_notifier import check_and_notify_cost_event

logger = logging.getLogger(__name__)


def walk(node):
    """知識ツリーの全ノードを再帰走査するジェネレータ"""
    yield node
    for child in node.child_nodes:
        yield from walk(child)


def find(session, concept_id):
    """リダイレクトマップを追跡し、セッションツリー内から指定IDの概念ノードを検索"""
    seen = set()
    while concept_id in session.concept_redirects and concept_id not in seen:
        seen.add(concept_id)
        concept_id = session.concept_redirects[concept_id]
    return next((n for n in walk(session.knowledge_tree) if n.concept_id == concept_id), None)


def descendants(session, concept_id):
    """指定概念ノードの子孫（下位ツリーおよびpart関係エッジ）IDの集合を取得"""
    nodes = {node.concept_id: node for node in walk(session.knowledge_tree)}
    children = {identifier: [child.concept_id for child in node.child_nodes]
                for identifier, node in nodes.items()}
    for edge in session.concept_edges:
        if edge.relation == 'part' and edge.source in nodes and edge.target in nodes:
            children[edge.source].append(edge.target)
    found = set()
    pending = [concept_id]
    while pending:
        identifier = pending.pop()
        if identifier in found:
            continue
        found.add(identifier)
        pending.extend(children.get(identifier, ()))
    return found


def spec(node):
    """ツリーノードからConceptSpecインスタンスを生成"""
    return ConceptSpec.model_validate(node.model_dump(include=set(ConceptSpec.model_fields)))


def normalize_concept_references(session):
    """マージによるリダイレクトを前提知識IDリストに反映して正規化"""
    for node in walk(session.knowledge_tree):
        node.prerequisite_concept_ids = list(dict.fromkeys(
            session.concept_redirects.get(cid, cid) for cid in node.prerequisite_concept_ids))



class DiagnosticService:
    def __init__(self, repository, providers, settings=None, embedding_providers=None):
        self.repo = repository
        self.providers = providers
        settings = settings or Settings()
        self.settings = settings
        self.deduplicator = ConceptDeduplicator(repository, embedding_providers or {
            'gemini': GoogleEmbeddingProvider(settings), 'demo': DemoEmbeddingProvider()}, providers, settings)
        self._prefetch_tasks = {}
        self._prefetch_running = set()
        self._initial_tasks = {}
        self._cross_map_tasks = {}
        self._generation_tasks = {}
        self.jobs = AgentJobs(self.repo, {'miner': self.settings.prefetch_concurrency,
            'question': 1, 'evaluation': self.settings.chat_processing_concurrency, 'merge': self.settings.cross_map_concurrency,
            'reception': 1, 'recorder': self.settings.chat_processing_concurrency})
        self.deduplicator.jobs = self.jobs
        self.on_graph_change = None
        self._cost_tracker: dict[str, SessionCost] = {}
        register_usage_handler(self._on_token_usage)

    def generation_tasks(self, session_id):
        """User expansions, initial publication and prefetches share the idle check."""
        current = asyncio.current_task()
        tasks = [task for (sid, _), task in self._prefetch_tasks.items() if sid == session_id]
        tasks.extend(task for task in [self._initial_tasks.get(session_id)] if task)
        tasks.extend(self._generation_tasks.get(session_id, {}))
        return {task for task in tasks if task is not current and not task.done()}

    def notify_graph_change(self, session_id, concept_ids=()):
        if self.on_graph_change:
            self.on_graph_change(session_id, concept_ids)

    def prefetch_finished(self, session_id):
        self.notify_graph_change(session_id)

    def _on_token_usage(self, session_id: str, agent_name: str, prompt_tokens: int, candidates_tokens: int, latency_ms: int = 0, concept_id: str | None = None):
        if session_id not in self._cost_tracker:
            try:
                session = self.repo.get(session_id)
                self._cost_tracker[session_id] = session.cost_summary.model_copy(deep=True)
            except Exception:
                self._cost_tracker[session_id] = SessionCost()
        self._cost_tracker[session_id].add(agent_name, prompt_tokens, candidates_tokens, latency_ms=latency_ms, concept_id=concept_id)

    def _merge_into(self, dest: Session, src: Session) -> None:
        """Merge state changes from src into fresh dest to resolve optimistic lock conflict."""
        dest_nodes = {n.concept_id: n for n in walk(dest.knowledge_tree)}
        src_nodes = {n.concept_id: n for n in walk(src.knowledge_tree)}
        for cid, s_node in src_nodes.items():
            if cid in dest_nodes:
                d_node = dest_nodes[cid]
                if s_node.child_nodes and not d_node.child_nodes:
                    d_node.child_nodes = s_node.child_nodes
                    d_node.child_candidates = s_node.child_candidates
                    d_node.granularity = s_node.granularity
                    d_node.terminal_reason = s_node.terminal_reason
                    d_node.terminal_confirmed = s_node.terminal_confirmed
                    d_node.expansion_kind = s_node.expansion_kind
                    d_node.expansion_error = s_node.expansion_error
                elif s_node.expansion_error and not d_node.expansion_error:
                    d_node.expansion_error = s_node.expansion_error
                if s_node.status != 'not_assessed' and d_node.status == 'not_assessed':
                    d_node.status = s_node.status

        existing_edges = {(e.source, e.target, e.relation) for e in dest.concept_edges}
        for e in src.concept_edges:
            if (e.source, e.target, e.relation) not in existing_edges:
                dest.concept_edges.append(e)
                existing_edges.add((e.source, e.target, e.relation))

        for cid, s_st in src.learning_states.items():
            if cid not in dest.learning_states:
                dest.learning_states[cid] = s_st
            else:
                d_st = dest.learning_states[cid]
                if s_st.questions_answered > d_st.questions_answered:
                    dest.learning_states[cid] = s_st
                elif s_st.questions_answered == d_st.questions_answered and s_st.status != 'not_assessed' and d_st.status == 'not_assessed':
                    dest.learning_states[cid] = s_st

        dest_qids = {q.question_id for q in dest.questions}
        for q in src.questions:
            if q.question_id not in dest_qids:
                dest.questions.append(q)
                dest_qids.add(q.question_id)

        dest_eids = {e.evidence_id for e in dest.evidence}
        for e in src.evidence:
            if e.evidence_id not in dest_eids:
                dest.evidence.append(e)
                dest_eids.add(e.evidence_id)

        answered = {e.question_id for e in dest.evidence}
        if dest.pending_question and dest.pending_question.question_id in answered:
            dest.pending_question = None
        if src.pending_question is not None and src.pending_question.question_id not in answered and dest.pending_question is None:
            dest.pending_question = src.pending_question

        if src.active_concept_id is not None:
            dest.active_concept_id = src.active_concept_id
        dest.paused_questions.update(src.paused_questions)
        dest.paused_questions = {cid: q for cid, q in dest.paused_questions.items() if q.question_id not in answered}
        for cid, survey in src.self_assessments.items():
            old = dest.self_assessments.get(cid)
            if old is None or survey.answered_at > old.answered_at:
                dest.self_assessments[cid] = survey
        used = {q.question_id for q in dest.questions}
        for cid, pool in src.question_pool.items():
            combined = {q.question_id: q for q in [*dest.question_pool.get(cid, []), *pool]}
            dest.question_pool[cid] = [q for qid, q in combined.items() if qid not in used]
        dest.deleted_concept_ids = sorted(set(dest.deleted_concept_ids) | set(src.deleted_concept_ids))
        if src.reassessment != dest.reassessment:
            dest.reassessment = src.reassessment
        if src.first_weak_question is not None and dest.first_weak_question is None:
            dest.first_weak_question = src.first_weak_question
            dest.first_weak_answer_time_ms = src.first_weak_answer_time_ms
        if src.complete:
            dest.complete = src.complete
            dest.stop_reason = src.stop_reason
        if src.initial_generation_complete:
            dest.initial_generation_complete = True
        if hasattr(src, 'cost_summary') and hasattr(dest, 'cost_summary'):
            dest.cost_summary.merge(src.cost_summary)

        prune_deleted(dest)

    def _save(self, session):
        prune_deleted(session)
        if session.session_id in self._cost_tracker:
            session.cost_summary.merge(self._cost_tracker[session.session_id])
            self._cost_tracker[session.session_id] = session.cost_summary.model_copy(deep=True)
        for attempt in range(10):
            try:
                self.repo.save(session)
                try:
                    check_and_notify_cost_event(session)
                except Exception as notify_err:
                    logger.warning("Cost notification check error: %s", notify_err)
                return
            except ConflictError:
                if attempt == 9:
                    raise
                fresh = self.repo.get(session.session_id)
                self._merge_into(fresh, session)
                if fresh.session_id in self._cost_tracker:
                    fresh.cost_summary.merge(self._cost_tracker[fresh.session_id])
                    self._cost_tracker[fresh.session_id] = fresh.cost_summary.model_copy(deep=True)
                session.__dict__.update(fresh.__dict__)
                time.sleep(0.02 * (attempt + 1))

    def _provider(self, mode: str):
        if mode in self.providers:
            return self.providers[mode]
        if 'demo' in self.providers and 'gemini' not in self.providers:
            return self.providers['demo']
        return self.providers.get('gemini') or next(iter(self.providers.values()))

    def schedule_initial_map(self, session):
        if session.initial_generation_complete or session.complete or session.initial_visible_depth <= 1:
            return
        if session.initial_root_pending and session.knowledge_tree.expansion_error:
            return
        task = self._initial_tasks.get(session.session_id)
        if task is not None and not task.done():
            return
        task = asyncio.get_running_loop().create_task(self._build_initial_map(session.session_id))
        self._initial_tasks[session.session_id] = task
        task.add_done_callback(lambda finished, sid=session.session_id: self._initial_tasks.pop(sid, None)
                               if self._initial_tasks.get(sid) is finished else None)

    async def _build_initial_map(self, session_id):
        finished = False
        try:
            if self.repo.get(session_id).initial_root_pending:
                await self._build_initial_root(session_id)
            target_depth = self.repo.get(session_id).initial_visible_depth
            for depth in range(1, target_depth):
                session = self.repo.get(session_id)
                if session.complete:
                    return
                concept_ids = [node.concept_id for node in walk(session.knowledge_tree)
                               if node.depth == depth and self.can_expand(session, node)]
                async def prepare(concept_id):
                    await self.prepare_concept(session_id, concept_id)
                    return concept_id
                # Reuse cached/in-flight generation and publish the ready branches
                # first. The shared prefetch semaphore limits API calls to five
                # by default; graph changes are applied against the latest tree.
                tasks = [asyncio.create_task(prepare(identifier)) for identifier in concept_ids]
                try:
                    for ready in asyncio.as_completed(tasks):
                        concept_id = await ready
                        latest = self.repo.get(session_id)
                        node = find(latest, concept_id)
                        if latest.complete or node is None or not self.can_expand(latest, node):
                            continue
                        for attempt in range(3):
                            try:
                                result = await self.decompose_concept(session_id, concept_id, background=True)
                                if result['error']:
                                    logger.warning('session_id=%s concept_id=%s initial_expansion_failed=%s',
                                        session_id, concept_id, result['error'])
                                break
                            except ConflictError:
                                if attempt == 2:
                                    logger.warning('session_id=%s concept_id=%s initial_expansion_conflicted',
                                        session_id, concept_id)
                                await asyncio.sleep(0.05 * (attempt + 1))
                            except (KeyError, ValueError) as exc:
                                logger.warning('session_id=%s concept_id=%s initial_expansion_skipped=%s',
                                    session_id, concept_id, type(exc).__name__)
                                break
                finally:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
            finished = True
        except Exception as exc:
            session = self.repo.get(session_id)
            finished = not session.initial_root_pending
            if session.initial_root_pending:
                session.knowledge_tree.expansion_error = str(exc)[:1000] if isinstance(exc, LLMError) else '初期マップの作成に失敗しました。再試行できます。'
                self._save(session)
            logger.exception('session_id=%s initial_map_failed=%s', session_id, type(exc).__name__)
        finally:
            # Interrupted initial work is resumed when the map is reopened.
            for _ in range(3 if finished else 0):
                try:
                    session = self.repo.get(session_id)
                    if session.initial_generation_complete:
                        break
                    session.initial_generation_complete = True
                    self._save(session)
                    break
                except (ConflictError, MergeConflict):
                    continue

    async def _build_initial_root(self, session_id):
        session = self.repo.get(session_id)
        async with self.jobs.track(session_id, 'miner', session.knowledge_tree.concept_id, 'initial_map'):
            with trace(session_id=session_id):
                result = await DecompositionAgent(self._provider(session.mode)).run(DecompositionInput(
                    theme=session.theme, domain_context=session.domain_context,
                    max_children=5 if session.mode == 'demo' else self.settings.initial_max_children))
        # Keep the root identity used by the already-live chat. Only generated
        # content is merged; never replace the session snapshot or its messages.
        root_id = session.knowledge_tree.concept_id
        generated_root_id = result.root_concept.concept_id
        result.root_concept.concept_id = root_id
        for child in result.child_nodes:
            child.prerequisite_concept_ids = [root_id if cid == generated_root_id else cid
                                             for cid in child.prerequisite_concept_ids]
        for attempt in range(10):
            session = self.repo.get(session_id)
            if session.complete or not session.initial_root_pending:
                return
            hashes = self.deduplicator.graph_hashes(session)
            prepared = await self.deduplicator.prepare(session, session.knowledge_tree, result)
            latest = self.repo.get(session_id)
            if latest.complete or not latest.initial_root_pending:
                return
            if self.deduplicator.graph_hashes(latest) != hashes:
                continue
            root = latest.knowledge_tree
            for name in ConceptSpec.model_fields:
                setattr(root, name, getattr(result.root_concept, name))
            children = [self.deduplicator.apply(latest, root, incoming,
                next((p for p in prepared.proposals if p.incoming_id == incoming.concept_id), None))
                for incoming in result.child_nodes]
            latest.learning_states[root_id] = update(root, [], latest.config)
            latest.initial_root_pending = False
            root.expansion_error = None
            normalize_concept_references(latest)
            try:
                self.repo.save(latest)
            except ConflictError:
                continue
            self.schedule_cross_map(session_id, [n.concept_id for n in children])
            self.notify_graph_change(session_id, [n.concept_id for n in children])
            return
        raise ConflictError('初期マップの保存が競合しました。再試行してください。')

    def retry_initial_map(self, session_id):
        session = self.repo.get(session_id)
        if session.initial_root_pending and not session.complete:
            session.knowledge_tree.expansion_error = None
            self._save(session)
            self.schedule_initial_map(session)
        return self.public(session)

    def decomposition_request(self, session, node, purpose):
        state = session.learning_states[node.concept_id]
        weak = [t.description for t in node.assessment_targets
                if state.target_states[t.target_id].understanding_score is not None
                and state.target_states[t.target_id].understanding_score < .7]
        nodes = {item.concept_id: item for item in walk(session.knowledge_tree)}
        ancestors = []
        ancestor_ids = set()
        cursor = nodes.get(node.parent_concept_id)
        while cursor is not None:
            ancestors.append(cursor.concept_name)
            ancestor_ids.add(cursor.concept_id)
            cursor = nodes.get(cursor.parent_concept_id)
        parent = nodes.get(node.parent_concept_id)
        mistakes = []
        for e in session.evidence:
            if (e.concept_id == node.concept_id or e.concept_id in ancestor_ids) and e.correctness != 'correct':
                ev_node = nodes.get(e.concept_id)
                cname = ev_node.concept_name if ev_node else e.concept_id
                q = next((q for q in session.questions if q.question_id == e.question_id), None)
                q_text = q.question_text if q else ''
                missing = '、'.join(e.missing_knowledge) if e.missing_knowledge else ''
                misconceptions = '、'.join(m.description for m in e.misconception_candidates) if e.misconception_candidates else ''
                desc = f"【項目: {cname}】問題: {q_text} | 誤答: {e.user_answer}"
                if missing:
                    desc += f" | 不足: {missing}"
                if misconceptions:
                    desc += f" | 誤解: {misconceptions}"
                mistakes.append(desc)
        return DecompositionInput(theme=node.concept_name, parent_concept_id=node.concept_id,
            current_depth=node.depth, purpose=purpose, domain_context=session.domain_context,
            root_theme=session.theme, target_concept=spec(node), ancestor_path=list(reversed(ancestors)),
            sibling_concept_names=[child.concept_name for child in parent.child_nodes
                                   if child.concept_id != node.concept_id] if parent else [],
            max_children=self.settings.expansion_max_children,
            weak_targets=weak if purpose != 'display_mastered_concept' else [],
            mistake_details=mistakes,
            existing_concept_ids=[n.concept_id for n in walk(session.knowledge_tree)] + list(session.concept_redirects) + session.deleted_concept_ids)

    def schedule_prefetch(self, session, nodes, allow_beyond_initial=False):
        if session.exploration_mode != 'manual' or session.manual_flow != 'decomposition_first' or session.complete:
            return
        loop = asyncio.get_running_loop()
        for node in nodes:
            # Initial generation stops one layer beyond the initial visible
            # depth. Deeper prefetches require a user-opened branch.
            if node.depth >= session.initial_visible_depth and self.settings.prefetch_ahead_layers == 0:
                continue
            if node.depth >= session.initial_visible_depth + self.settings.prefetch_ahead_layers and not allow_beyond_initial:
                continue
            if not self.can_expand(session, node):
                continue
            key = (session.session_id, node.concept_id)
            status, prepared = self.repo.get_prefetch(*key)
            task = self._prefetch_tasks.get(key)
            if task is not None and task.done():
                self._prefetch_tasks.pop(key, None)
                task = None
            if task is not None or status == 'failed':
                continue
            # A prepared branch is reconciled against the current graph when
            # opened; do not regenerate unrelated branches as the graph grows.
            if status == 'ready' and prepared is not None:
                continue
            task = loop.create_task(self._prefetch_one(*key))
            self._prefetch_tasks[key] = task
            task.add_done_callback(lambda finished, task_key=key: self._prefetch_tasks.pop(task_key, None)
                                   if self._prefetch_tasks.get(task_key) is finished else None)
            task.add_done_callback(lambda finished, sid=session.session_id: self.prefetch_finished(sid))

    async def prepare_concept(self, session_id, concept_id):
        """Explicit background preparation, also when automatic prefetch is disabled."""
        key = (session_id, concept_id)
        task = self._prefetch_tasks.get(key)
        if task is None or task.done():
            status, prepared = self.repo.get_prefetch(*key)
            if status == 'ready' and prepared is not None:
                return
            task = asyncio.create_task(self._prefetch_one(*key))
            self._prefetch_tasks[key] = task
            task.add_done_callback(lambda finished: self._prefetch_tasks.pop(key, None)
                                   if self._prefetch_tasks.get(key) is finished else None)
            task.add_done_callback(lambda finished: self.prefetch_finished(session_id))
        await task

    @tracked('miner', 'prefetch')
    async def _prefetch_one(self, session_id, concept_id):
        # All initial, manual and chat decompositions share durable per-map slots.
        self._prefetch_running.add((session_id, concept_id))
        try:
            session = self.repo.get(session_id)
            node = find(session, concept_id)
            if node is None or not self.can_expand(session, node):
                return
            status, cached = self.repo.get_prefetch(session_id, concept_id)
            if status == 'ready' and cached is not None:
                result = cached.decomposition
            else:
                with trace(session_id=session_id, concept_id=concept_id):
                    result = await DecompositionAgent(self._provider(session.mode)).run(
                        self.decomposition_request(session, node, 'expand_concept'))
            if not result.child_nodes:
                for _ in range(3):
                    latest = self.repo.get(session_id)
                    current = find(latest, concept_id)
                    if current is None or not self.can_expand(latest, current):
                        return
                    self.mark_terminal(current, result.root_concept.terminal_reason)
                    try:
                        self._save(latest)
                    except ConflictError:
                        continue
                    self.repo.delete_prefetch(session_id, concept_id)
                    return
            prepared = await self.deduplicator.prepare(session, node, result)
            self.repo.save_prefetch(session_id, concept_id, prepared)
        except Exception as exc:
            logger.warning('session_id=%s concept_id=%s prefetch_failed=%s', session_id, concept_id, type(exc).__name__)
            self.jobs.fail_current(session_id)
            try:
                self.repo.save_prefetch(session_id, concept_id, None)
                for _ in range(3):
                    latest = self.repo.get(session_id)
                    current = find(latest, concept_id)
                    if current is None or not self.can_expand(latest, current):
                        break
                    reason = str(exc) if isinstance(exc, LLMError) else '処理中にエラーが発生しました。再試行してください。'
                    current.expansion_error = f'下位項目の生成に失敗しました。{reason}'[:1000]
                    try:
                        self._save(latest)
                        break
                    except ConflictError:
                        continue
            except Exception as save_exc:
                logger.warning('session_id=%s concept_id=%s prefetch_status_save_failed=%s',
                               session_id, concept_id, type(save_exc).__name__)
        finally:
            self._prefetch_running.discard((session_id, concept_id))

    @staticmethod
    async def _notify(on_progress, agent: str, stage: str, message: str, concept_id: str | None = None, concept_name: str | None = None):
        if on_progress is not None:
            try:
                import inspect
                sig = inspect.signature(on_progress)
                params_len = len(sig.parameters)
                if params_len >= 6:
                    res = on_progress(agent, stage, message, concept_id, concept_name, current_job_id())
                elif params_len >= 5:
                    res = on_progress(agent, stage, message, concept_id, concept_name)
                elif params_len == 4:
                    res = on_progress(agent, stage, message, concept_id)
                else:
                    res = on_progress(agent, stage, message)
                if asyncio.iscoroutine(res):
                    await res
            except Exception as e:
                logger.debug("on_progress error: %s", e)

    async def start(self, request, origin=None, candidate_id=None, on_progress=None,
                    user_id='guest_user', defer_initial_map=False):
        """診断セッションを開始し、初期知識マップの第1層を生成・登録する。
        
        1. テーマ解析とDecompositionAgentによる第1層ノード群の生成
        2. 重複概念の排除・正規化（ConceptDeduplicator）
        3. 診断状態（LearningState）の初期化とセッション保存
        4. 1問目の診断問題生成（advance_safely）
        5. 第2層ノードの非同期並列先行生成（schedule_initial_map: 約25ノード）を開始
        """
        if request.mode is None:
            request = request.model_copy(update={'mode': 'gemini' if 'gemini' in self.providers else 'demo'})
        if request.mode == 'demo' and '微分' not in request.theme and origin is None:
            raise ValueError('デモ教材は「微分」専用です。任意テーマの診断にはGeminiモードを選んでください。')
        mode = request.mode if request.mode in self.providers else ('demo' if 'demo' in self.providers else request.mode)
        new_manual = request.exploration_mode == 'manual' and request.manual_flow == 'decomposition_first'
        session_id = uid('sess')
        if request.entry_mode in ('chat', 'map_chat'):
            root = Node(concept_id=uid('root'), concept_name=request.theme,
                        description=request.domain_context or f'{request.theme}について会話から知識を整理します。',
                        granularity='broad', knowledge_type='conceptual', assessment_targets=[
                            Target(target_id='theme', description=f'{request.theme}について説明できる',
                                   knowledge_type='conceptual', importance='core')])
            session = Session(session_id=session_id, theme=request.theme, domain_context=request.domain_context,
                mode=mode, exploration_mode=request.exploration_mode, manual_flow=request.manual_flow,
                initial_visible_depth=2, initial_generation_complete=request.entry_mode == 'chat',
                initial_root_pending=request.entry_mode == 'map_chat',
                answer_format=request.answer_format, allowed_question_types=request.allowed_question_types,
                knowledge_tree=root, queue=[])
            session.learning_states[root.concept_id] = update(root, [], session.config)
            self.repo.create(session, user_id=user_id, origin=origin, candidate_id=candidate_id)
            if not defer_initial_map:
                self.schedule_initial_map(session)
            return self.public(session)
        await self._notify(on_progress, "DecompositionAgent", "analyzing", f"学習テーマ「{request.theme}」の目標・文脈を解析中...", concept_name=request.theme)
        
        # 1. 第1層（主要概念ノード群）の生成
        async with self.jobs.track(session_id, 'miner', None, 'initial_map'):
            with trace(session_id=session_id):
                await self._notify(on_progress, "DecompositionAgent", "generating", "第1層の重要概念ノード群を構築中...", concept_name=request.theme)
                result = await DecompositionAgent(self._provider(mode)).run(DecompositionInput(
                    theme=request.theme, domain_context=request.domain_context,
                    is_divergent_map=origin is not None,
                    max_children=5 if request.mode == 'demo' else self.settings.initial_max_children))
        # The initial map always opens two layers. Model depth suggestions do
        # not disable the second layer for broad themes.
        initial_visible_depth = 2 if new_manual else 1
        root = Node(**result.root_concept.model_dump())
        session = Session(session_id=session_id, theme=request.theme, domain_context=request.domain_context, mode=mode, exploration_mode=request.exploration_mode,
                          manual_flow=request.manual_flow, decomposition_max_depth=None,
                          initial_visible_depth=initial_visible_depth,
                          initial_generation_complete=initial_visible_depth <= 1,
                          decomposition_depth_reason=None,
                          answer_format=request.answer_format, allowed_question_types=request.allowed_question_types, knowledge_tree=root,
                          queue=[])
        
        # 2. 既存知識・同一マップ内での概念重複排除
        deduplicate = new_manual
        await self._notify(on_progress, "ConceptDeduplicator", "deduplicating", "既存知識との重複排除・整合性を検証中...", concept_id=root.concept_id, concept_name=request.theme)
        prepared = await self.deduplicator.prepare(session, root, result) if deduplicate else None
        for incoming in result.child_nodes:
            proposal = next((p for p in prepared.proposals if p.incoming_id == incoming.concept_id), None) if prepared else None
            self.deduplicator.apply(session, root, incoming, proposal)
        normalize_concept_references(session)
        if request.exploration_mode != 'manual':
            session.queue = [n.concept_id for n in root.child_nodes]
        for n in walk(root):
            session.learning_states[n.concept_id] = update(n, [], session.config)
            
        # 3. セッションをDB（FirestoreまたはSQLite）へ永続化
        self.repo.create(session, user_id=user_id, origin=origin, candidate_id=candidate_id)
        
        # 4. 他のマップとの共通概念リンク（クロス抓マージ）を非同期起動
        self.schedule_cross_map(session.session_id,
            [node.concept_id for node in walk(root)])
        session = self.repo.get(session.session_id)
        
        # 5. 1問目の診断問題を生成（失敗してもセッションは保持し再試行可能に）
        error = await self.advance_safely(session)
        
        # 6. バックグラウンドで第2層の先行生成（並列prefetch）を開始（約25ノード）
        self.schedule_prefetch(session, session.knowledge_tree.child_nodes)
        self.schedule_initial_map(session)
        if session.pending_question:
            q_node = find(session, session.pending_question.concept_id)
            if q_node:
                await self._notify(on_progress, "QuestionAgent", "ready", f"「{q_node.concept_name}」の診断問題を出題", concept_id=q_node.concept_id, concept_name=q_node.concept_name)
        await self._notify(on_progress, "DiagnosticService", "ready", "初期知識ツリーの描画準備が完了", concept_id=root.concept_id, concept_name=request.theme)
        return self.public(session, error=error)

    def schedule_cross_map(self, map_id, concept_ids):
        if not concept_ids:
            return
        try:
            self.repo.get_map(map_id)
        except KeyError:
            return
        task = asyncio.get_running_loop().create_task(self._cross_map_worker(map_id, concept_ids))
        self._cross_map_tasks.setdefault(map_id, set()).add(task)
        task.add_done_callback(lambda finished, mid=map_id:
            self._cross_map_tasks.get(mid, set()).discard(finished))

    async def _cross_map_worker(self, map_id, concept_ids):
        await self.link_other_maps(map_id, concept_ids)

    def schedule_branch_reconciliation(self, map_id, concept_ids):
        task = asyncio.create_task(self._reconcile_published_branch(map_id, concept_ids))
        self._cross_map_tasks.setdefault(map_id, set()).add(task)
        task.add_done_callback(lambda finished: self._cross_map_tasks.get(map_id, set()).discard(finished))

    async def _reconcile_published_branch(self, map_id, concept_ids):
        """New graph comparisons never block publication of already prepared children."""
        for concept_id in concept_ids:
            try:
                for attempt in range(3):
                    session = self.repo.get(map_id)
                    node = find(session, concept_id)
                    if session.complete or node is None or node.concept_id != concept_id:
                        break
                    parent = find(session, node.parent_concept_id)
                    if parent is None:
                        break
                    hashes = self.deduplicator.graph_hashes(session)
                    proposal = await self.deduplicator.propose(session, parent, spec(node))
                    if proposal is None:
                        break
                    latest = self.repo.get(map_id)
                    # Recheck after the LLM yields. Never apply a canonical result
                    # to edited/deleted concepts, or overwrite concurrent answers.
                    latest_hashes = self.deduplicator.graph_hashes(latest)
                    if latest.complete:
                        break
                    if any(latest_hashes.get(cid) != hashes.get(cid) for cid in
                           (concept_id, parent.concept_id, proposal.existing_id)):
                        continue
                    try:
                        self.deduplicator.merge_existing(latest, proposal.existing_id, concept_id, proposal.canonical)
                        self.repo.save(latest)
                    except (ConflictError, MergeConflict):
                        continue
                    self.notify_graph_change(map_id, [proposal.existing_id])
                    break
            except Exception as exc:
                logger.warning('published_branch_reconciliation_failed map_id=%s concept_id=%s error=%s',
                               map_id, concept_id, type(exc).__name__)
        await self.link_other_maps(map_id, concept_ids)

    async def link_other_maps(self, map_id, concept_ids):
        for concept_id in concept_ids:
            try:
                session = self.repo.get(map_id)
                node = find(session, concept_id)
                if node is None:
                    continue
                proposal = await self.deduplicator.propose_other_maps(session, node)
                if proposal is None:
                    continue
                canonical_id, target_mapping = proposal
                self.repo.link_canonical(map_id, concept_id, canonical_id, target_mapping)
                logger.info('cross_map_merge_executed map_id=%s concept_id=%s canonical_concept_id=%s',
                            map_id, concept_id, canonical_id)
            except Exception as exc:
                logger.warning('cross_map_merge_failed map_id=%s concept_id=%s error=%s',
                               map_id, concept_id, type(exc).__name__)
            await asyncio.sleep(0)

    def get_session(self, session_id):
        session = self.repo.get(session_id)
        if (session.exploration_mode == 'manual' and session.manual_flow == 'decomposition_first'
                and not session.complete and session.initial_visible_depth < 2):
            session.initial_visible_depth = 2
            session.initial_generation_complete = not any(
                node.depth == 1 and self.can_expand(session, node) for node in walk(session.knowledge_tree))
            self.repo.save(session)
        # Visible nodes below the initial map exist only in branches opened by
        # the learner. Resume their missing prefetches after a process restart.
        self.schedule_prefetch(session, (node for node in walk(session.knowledge_tree) if node.depth > 0),
                               allow_beyond_initial=True)
        self.schedule_initial_map(session)
        return self.public(session)

    def record(self, session, plan):
        plan.session_question_count = len(session.evidence)
        session.next_action = plan
        session.policy_history.append(plan)
        logger.info('session_id=%s concept_id=%s diagnostic_action=%s reason=%s', session.session_id, plan.concept_id, plan.action, plan.reason_code)

    async def advance_safely(self, session):
        error = None
        try:
            await self.advance(session)
        except LLMError as exc:
            error = str(exc)
        self._save(session)
        return error

    async def advance(self, session):
        if session.reassessment:
            return await self.generate_reassessment(session)
        if session.exploration_mode == 'manual':
            return await self.advance_manual(session)
        if session.pending_question or session.pending_review or session.complete:
            return
        if session.config.max_total_questions is not None and len(session.evidence) >= session.config.max_total_questions:
            return self.finish(session, 'SESSION_LIMIT')
        if session.approved_expansion_id:
            await self.expand_node(session, find(session, session.approved_expansion_id))
            session.approved_expansion_id = None
        while True:
            if not session.queue:
                if not session.deferred_concepts:
                    reason = ('COVERAGE_COMPLETE' if session.exploration_mode == 'comprehensive' else
                              'GAP_UNRESOLVED' if session.review_history else 'ALL_CONCEPTS_ASSESSED')
                    return self.finish(session, reason)
                if session.exploration_mode == 'focused':
                    # Compare siblings after each has finished its own assessment.
                    # Unknown scores cannot be asserted to be the lowest observed understanding.
                    def priority(cid):
                        st = session.learning_states[cid]
                        return (st.understanding_score is None,
                                st.understanding_score if st.understanding_score is not None else 1,
                                -st.diagnostic_confidence)
                    cid = min(session.deferred_concepts, key=priority)
                    session.deferred_concepts.clear()
                    session.focused_path.append(cid)
                else:
                    cid = session.deferred_concepts.pop(0)
                node = find(session, cid)
                session.queue = [cid]
                if node.depth >= session.config.review_min_depth:
                    self.record(session, Plan(action='review_findings', concept_id=cid, reason_code='USER_REVIEW_REQUIRED'))
                    self.prepare_review(session, node)
                    return
                # Persist the selected branch in case decomposition fails.
                session.approved_expansion_id = cid
                await self.expand_node(session, node)
                session.approved_expansion_id = None
                continue

            node = find(session, session.queue[0])
            state = session.learning_states[node.concept_id]
            if node.assessment_scope == 'covered_by_parent':
                session.queue.pop(0)
                continue
            plan = decide(node, state, len(session.evidence), session.config, session.answer_format, session.allowed_question_types)
            self.record(session, plan)
            if plan.action == 'complete':
                return self.finish(session, plan.reason_code)
            if plan.action in ('move_to_next_concept', 'expand_concept', 'review_findings'):
                if state.questions_answered >= session.config.max_questions_per_concept and state.status not in ('mastered', 'weak'):
                    state.status = node.status = 'uncertain'
                perfect = self.perfectly_assessed(session, node)
                if perfect:
                    # Display one child level, without assigning unobserved scores or scheduling questions.
                    await self.display_mastered_children(session, node)
                elif self.can_expand(session, node) or (node.depth >= session.config.review_min_depth and state.status != 'mastered'):
                    if node.concept_id not in session.deferred_concepts:
                        session.deferred_concepts.append(node.concept_id)
                session.queue.pop(0)
                if node.concept_id not in session.completed_concepts:
                    session.completed_concepts.append(node.concept_id)
                continue
            question = await self.obtain_question(session, node, plan)
            session.questions.append(question)
            session.pending_question = question
            if state.questions_answered == 0:
                state.status = node.status = 'assessing'
            return

    async def obtain_question(self, session, node, plan):
        """プールから問題を取り出すか、無ければ一括生成してプールに格納し1問目を返す"""
        pool = session.question_pool.setdefault(node.concept_id, [])
        used_ids = {q.question_id for q in session.questions}
        while pool:
            candidate = pool.pop(0)
            if candidate.question_id not in used_ids:
                return candidate

        return await self._build_questions(session, node, plan, pool)

    @tracked('question', 'question_generation')
    async def _build_questions(self, session, node, plan, pool):
        await self._notify(progress_sink.get(), 'QuestionAgent', 'generating',
            f'「{node.concept_name}」の問題を生成中', node.concept_id, node.concept_name)
        req = plan.question_requests[0]
        prev_summaries = [q.question_text for q in session.questions if q.concept_id == node.concept_id]

        # 過去全層の誤答履歴（先祖・他項目含む）を抽出して問題生成に反映
        ancestor_mistakes = []
        for e in session.evidence:
            if e.correctness != 'correct':
                ev_node = find(session, e.concept_id)
                cname = ev_node.concept_name if ev_node else e.concept_id
                q = next((q for q in session.questions if q.question_id == e.question_id), None)
                q_text = q.question_text if q else ''
                missing = '、'.join(e.missing_knowledge) if e.missing_knowledge else ''
                misconceptions = '、'.join(m.description for m in e.misconception_candidates) if e.misconception_candidates else ''
                desc = f"【項目: {cname}】問題: {q_text} | ユーザー回答: {e.user_answer}"
                if missing:
                    desc += f" | 不足知識: {missing}"
                if misconceptions:
                    desc += f" | 推定誤解: {misconceptions}"
                ancestor_mistakes.append(desc)

        # 直近の誤答（最大3件）に絞り込んでプロンプト長を抑え、生成速度を高速化
        ancestor_mistakes = ancestor_mistakes[-3:]

        batch_count = 1 if session.mode == 'demo' else 2
        with trace(session_id=session.session_id, concept_id=node.concept_id, assessment_target_id=req.assessment_target_id):
            agent = QuestionAgent(self._provider(session.mode))
            inp = QuestionInput(
                concept=spec(node),
                request=req,
                domain_context=session.domain_context,
                previous_question_summaries=prev_summaries,
                ancestor_mistakes=ancestor_mistakes,
                batch_count=batch_count,
            )
            if batch_count > 1:
                questions = await agent.run_batch(inp)
            else:
                questions = [await agent.run(inp)]

        chosen = questions[0]
        for rem in questions[1:]:
            pool.append(rem)
        return chosen

    async def select_concept(self, session_id, concept_id, on_progress=None):
        for attempt in range(3):
            try:
                return await self._select_concept_once(session_id, concept_id, on_progress=on_progress)
            except ConflictError:
                if attempt == 2:
                    raise

    async def _select_concept_once(self, session_id, concept_id, on_progress=None):
        session = self.repo.get(session_id)
        if session.reassessment:
            raise ValueError('追加確認に回答するか、中止してから項目を切り替えてください。')
        if session.exploration_mode != 'manual' or session.complete:
            raise ValueError('項目を選ぶ探索方式で、未終了の診断を選んでください。')
        node = find(session, concept_id)
        if node is None:
            raise KeyError(concept_id)
        concept_id = node.concept_id
        if node.depth == 0:
            raise ValueError('テーマの下にある知識項目を選んでください。')
        if session.pending_question and session.pending_question.concept_id != concept_id:
            session.paused_questions[session.pending_question.concept_id] = session.pending_question
            session.pending_question = None
        session.active_concept_id = concept_id
        if session.pending_question is None:
            session.pending_question = session.paused_questions.pop(concept_id, None)
        # Selection is durable before either generation starts.
        self._save(session)
        token = progress_sink.set(on_progress)
        try:
            error = await self.advance_safely(session)
        finally:
            progress_sink.reset(token)
        if session.pending_question:
            await self._notify(on_progress, "QuestionAgent", "ready", f"概念「{node.concept_name}」の診断問題を出題", concept_id=node.concept_id, concept_name=node.concept_name)
        return self.public(session, error=error)

    async def reassess(self, session_id, concept_id):
        session = self.repo.get(session_id)
        node = find(session, concept_id)
        if node is None:
            raise KeyError(concept_id)
        concept_id = node.concept_id
        if node.depth == 0 or not session.learning_states[concept_id].questions_answered:
            raise ValueError('回答済みの知識項目を選んでください。')
        if session.reassessment and session.reassessment.concept_id != concept_id:
            raise ValueError('現在の追加確認に回答するか、中止してください。')
        if (session.pending_question and session.pending_question.concept_id == concept_id) or concept_id in session.paused_questions:
            raise ValueError('この項目には未回答の問題があります。先にその問題に回答してください。')
        if session.reassessment is None:
            session.reassessment = Reassessment(concept_id=concept_id)
            self._save(session)
        error = await self.advance_safely(session)
        return self.public(session, error=error)

    async def generate_reassessment(self, session):
        extra = session.reassessment
        if extra.question:
            return
        node = find(session, extra.concept_id)
        state = session.learning_states[node.concept_id]
        plan = question_plan(node, state, session.config, session.answer_format, session.allowed_question_types, reassess=True)
        self.record(session, plan)
        question = await self.obtain_question(session, node, plan)
        session.questions.append(question)
        extra.question = question
        session.reassessment_question_ids.append(question.question_id)

    async def cancel_reassessment(self, session_id):
        session = self.repo.get(session_id)
        if session.reassessment:
            session.reassessment = None
            self._save(session)
        return self.public(session)

    async def advance_manual(self, session):
        if session.reassessment:
            return await self.generate_reassessment(session)
        if session.complete or session.active_concept_id is None:
            return
        if session.config.max_total_questions is not None and len(session.evidence) >= session.config.max_total_questions:
            return self.finish(session, 'SESSION_LIMIT')
        node = find(session, session.active_concept_id)
        state = session.learning_states[node.concept_id]
        plan = question_plan(node, state, session.config, session.answer_format, session.allowed_question_types,
                             reassess=state.questions_answered > 0)
        self.record(session, plan)
        if session.manual_flow == 'decomposition_first':
            if not session.pending_question:
                await self.generate_question(session, node, plan)
            return
        retry_expansion_only = bool(node.expansion_error and self.can_expand(session, node)
                                    and (session.pending_question or state.questions_answered > 0))
        jobs = []
        if not session.pending_question and not retry_expansion_only:
            jobs.append(self.generate_question(session, node, plan))
        # Selection itself requests the next layer; no score or automatic branch choice gates it.
        if self.can_expand(session, node):
            jobs.append(self.generate_children(session, node, 'expand_concept'))
        # Independent requests run concurrently. Keep either successful result if its peer fails.
        results = await asyncio.gather(*jobs, return_exceptions=True)
        errors = []
        for result in results:
            if isinstance(result, LLMError):
                errors.append(str(result))
            elif isinstance(result, BaseException):
                raise result
        if retry_expansion_only and not session.pending_question:
            session.active_concept_id = None
        if errors:
            raise LLMError(' / '.join(errors))

    async def generate_question(self, session, node, plan):
        question = await self.obtain_question(session, node, plan)
        session.questions.append(question)
        session.pending_question = question
        state = session.learning_states[node.concept_id]
        if state.questions_answered == 0:
            state.status = node.status = 'assessing'

    async def decompose_concept(self, session_id, concept_id, background=False, on_progress=None):
        """競合時は準備済み結果を再利用し、他の枝の保存を待って再照合する。"""
        task = asyncio.current_task()
        active = self._generation_tasks.setdefault(session_id, {})
        active[task] = active.get(task, 0) + 1
        try:
            for attempt in range(10):
                try:
                    return await self._decompose_concept_once(session_id, concept_id, background, on_progress=on_progress)
                except (ConflictError, MergeConflict):
                    if attempt == 9:
                        raise
                    # Initial branches may publish while a deep branch is prepared.
                    # Yield rather than exhausting retries against the same busy graph.
                    await asyncio.sleep(min(.05 * 2**attempt, .5))
        finally:
            active[task] -= 1
            if not active[task]:
                active.pop(task)
            if not active:
                self._generation_tasks.pop(session_id, None)
            self.notify_graph_change(session_id)

    async def _decompose_concept_once(self, session_id, concept_id, background, on_progress=None):
        """ノード手動分割の1回分の実行処理。先行生成キャッシュの確認、LLMによる子ノード生成、マージを行う"""
        session = self.repo.get(session_id)
        if session.exploration_mode != 'manual' or session.manual_flow != 'decomposition_first' or session.complete:
            raise ValueError('このセッションでは分解だけの操作を利用できません。')
        node = find(session, concept_id)
        if node is None:
            raise KeyError(concept_id)
        concept_id = node.concept_id
        if node.depth == 0:
            raise ValueError('主要項目を選んでください。')
        if node.child_nodes or any(edge.source == node.concept_id and edge.relation == 'part' for edge in session.concept_edges):
            return self.public(session)
        if not self.can_expand(session, node):
            raise ValueError('この項目はこれ以上分解できません。')
        task = self._prefetch_tasks.get((session_id, concept_id))
        current_task = asyncio.current_task()
        if task is not None and task is not current_task and not task.done():
            await task
            session = self.repo.get(session_id)
            node = find(session, concept_id)
            if node is None:
                raise KeyError(concept_id)
            if node.child_nodes or any(edge.source == node.concept_id and edge.relation == 'part' for edge in session.concept_edges):
                return self.public(session)
            if not self.can_expand(session, node):
                return self.public(session)
        status, prepared = self.repo.get_prefetch(session_id, concept_id)
        baseline_hashes = self.deduplicator.graph_hashes(session)
        reconcile_after_publish = False
        if prepared is not None:
            existing = {item.concept_id for item in walk(session.knowledge_tree)}
            child_ids = {item.concept_id for item in prepared.decomposition.child_nodes}
            current_hashes = self.deduplicator.graph_hashes(session)
            if (child_ids & existing or prepared.decomposition.root_concept.concept_id != node.concept_id
                    or (prepared.compared_concept_hashes.get(node.concept_id) is not None
                        and prepared.compared_concept_hashes[node.concept_id] != current_hashes[node.concept_id])):
                # Parallel sibling requests can propose the same ID. Regenerate against the current tree.
                self.repo.delete_prefetch(session_id, concept_id)
                prepared = None
            elif prepared.compared_concept_hashes != current_hashes:
                # The content is ready. Publish it without acquiring a worker or
                # awaiting another LLM. Stale canonical proposals are unsafe to
                # apply; reconcile persisted nodes (including their evidence) later.
                prepared = prepared.model_copy(update={'proposals': []})
                reconcile_after_publish = True
        error = None
        try:
            if prepared is None:
                await self._notify(on_progress, "DecompositionAgent", "generating", f"「{node.concept_name}」の下位項目を生成中...", concept_id=node.concept_id, concept_name=node.concept_name)
                prepared = await self.prepare_children(session, node, 'expand_concept')
            # Keep generated results across CAS retries. The parent hash above
            # invalidates them if its meaning changes; other changes recheck merges.
            self.repo.save_prefetch(session_id, concept_id, prepared)
            status = 'ready'
        except LLMError as exc:
            error = str(exc)
        latest = self.repo.get(session_id)
        if latest.complete or self.deduplicator.graph_hashes(latest) != baseline_hashes:
            raise MergeConflict('分解中にマップが変わったため、最新の構造で再照合します。')
        session, node = latest, find(latest, concept_id)
        if error:
            node.expansion_error = f'下位項目の生成に失敗しました。{error}'[:1000]
            children = []
        else:
            children = await self.generate_children(session, node, 'expand_concept', prefetched=prepared)
        self._save(session)
        if children:
            if reconcile_after_publish:
                self.schedule_branch_reconciliation(session_id, [child.concept_id for child in children])
            else:
                self.schedule_cross_map(session_id, [child.concept_id for child in children])
            self.notify_graph_change(session_id, [child.concept_id for child in children])
        if status is not None and error is None:
            self.repo.delete_prefetch(session_id, concept_id)
        if error is None:
            self.schedule_prefetch(session, node.child_nodes,
                allow_beyond_initial=not background and node.depth >= session.initial_visible_depth)
        await self._notify(on_progress, "DecompositionAgent", "failed" if error else "ready",
            error or f"「{node.concept_name}」のツリー展開が完了", concept_id=node.concept_id, concept_name=node.concept_name)
        return self.public(session, error=error)

    async def add_concept(self, session_id, request: AddConceptRequest):
        for attempt in range(3):
            try:
                return await self._add_concept_once(session_id, request)
            except ConflictError:
                if attempt == 2:
                    raise

    async def _add_concept_once(self, session_id, request: AddConceptRequest):
        session = self.repo.get(session_id)
        if session.exploration_mode != 'manual' or session.manual_flow != 'decomposition_first' or session.complete:
            raise ValueError('このセッションでは知識項目を追加できません。')
        parent = find(session, request.parent_concept_id)
        if parent is None:
            raise KeyError(request.parent_concept_id)
        if not parent.child_nodes and not any(edge.source == parent.concept_id and edge.relation == 'part' for edge in session.concept_edges):
            raise ValueError('先にこの項目を分解してから、不足している子項目を追加してください。')
        linked = [find(session, edge.target) for edge in session.concept_edges
                  if edge.source == parent.concept_id and edge.relation == 'part']
        existing_ids = [item.concept_id for item in walk(session.knowledge_tree)] + list(session.concept_redirects)
        concept_id = uid('user')
        while concept_id in existing_ids:
            concept_id = uid('user')
        addition = AdditionInput(concept_id=concept_id, concept_name=request.concept_name,
            note=request.note, parent_concept=spec(parent),
            siblings=[spec(child) for child in [*parent.child_nodes, *linked] if child],
            domain_context=session.domain_context, target_depth=parent.depth + 1,
            existing_concept_ids=existing_ids)
        async with self.jobs.track(session_id, 'miner', parent.concept_id, 'addition'):
            with trace(session_id=session_id, concept_id=parent.concept_id):
                result = await ConceptAdditionAgent(self._provider(session.mode)).run(addition)
        proposal = await self.deduplicator.propose(session, parent, result)
        child = self.deduplicator.apply(session, parent, result, proposal,
            origin='user_added', user_note=request.note)
        self._save(session)
        if child.concept_id == result.concept_id:
            self.schedule_cross_map(session_id, [child.concept_id])
        if child.concept_id == result.concept_id:
            self.schedule_prefetch(session, [child],
                allow_beyond_initial=parent.depth >= session.initial_visible_depth)
        return self.public(session)

    async def delete_concept(self, session_id, concept_id):
        for attempt in range(10):
            session = self.repo.get(session_id)
            if concept_id == session.knowledge_tree.concept_id:
                raise ValueError('テーマ全体はマップ管理から削除してください。')
            if concept_id in session.deleted_concept_ids:
                return {**self.public(session), 'deleted_ids': []}
            node = find(session, concept_id)
            if node is None:
                raise KeyError(concept_id)
            removed = descendants(session, node.concept_id) | {node.concept_id}
            if session.knowledge_tree.concept_id in removed:
                raise ValueError('ルートを含む循環した枝は削除できません。')
            removed |= {old for old, new in session.concept_redirects.items() if new in removed}
            session.deleted_concept_ids = sorted(set(session.deleted_concept_ids) | removed)
            prune_deleted(session)
            session.chat.routing_records.clear()
            session.chat.assessment_records.clear()
            try:
                # On conflict recompute descendants; do not merge an old deletion snapshot.
                self.repo.save(session)
                break
            except ConflictError:
                if attempt == 9:
                    raise
        self.jobs.cancel_nodes(session_id, removed)
        for (sid, cid), task in list(self._prefetch_tasks.items()):
            if sid == session_id and cid in removed and not task.done():
                task.cancel()
        self.repo.delete_concept_artifacts(session_id, list(removed))
        return {**self.public(session), 'deleted_ids': sorted(removed)}

    async def stop(self, session_id):
        session = self.repo.get(session_id)
        if session.reassessment:
            raise ValueError('追加確認に回答するか、中止してから終了してください。')
        if session.exploration_mode != 'manual':
            raise ValueError('この操作は項目を選ぶ探索方式で利用できます。')
        if session.manual_flow == 'decomposition_first' and not session.complete:
            if not session.initial_generation_complete:
                raise ValueError('初回の知識項目を準備中です。生成が終わってから終了してください。')
            nodes = [n for n in walk(session.knowledge_tree) if n.depth > 0]
            chat_assessed = conversation_assessed_ids(session)
            unanswered = [n for n in nodes if n.concept_id not in session.self_assessments and n.concept_id not in chat_assessed]
            unresolved = [n for n in nodes if n.concept_id in session.self_assessments
                          and session.self_assessments[n.concept_id].level == 'unsure'
                          and n.concept_id not in chat_assessed
                          and not any(e.concept_id == n.concept_id and e.correctness != 'ungradable'
                                      for e in session.evidence)]
            if unanswered or unresolved:
                first = (unanswered or unresolved)[0]
                raise ValueError(f'終了前に全項目の自己評価が必要です。未回答 {len(unanswered)} 件、問題での確認待ち {len(unresolved)} 件。まず「{first.concept_name}」を確認してください。')
        if not session.complete:
            self.finish(session, 'USER_FINISHED_EXPLORATION')
            session.paused_questions.clear()
            session.initial_generation_complete = True
            self._save(session)
        return self.public(session)

    async def self_assess(self, session_id, request: SelfAssessmentRequest):
        for attempt in range(3):
            session = self.repo.get(session_id)
            if session.exploration_mode != 'manual' or session.complete:
                raise ValueError('進行中の探索で回答してください。')
            node = find(session, request.concept_id)
            if node is None:
                raise KeyError(request.concept_id)
            if node.depth == 0:
                raise ValueError('テーマ自体は下位項目から集計します。')
            session.self_assessments[node.concept_id] = SelfAssessment(level=request.level,
                                                                       origin_map_id=session_id)
            try:
                self._save(session)
                return self.public(session)
            except ConflictError:
                if attempt == 2:
                    raise

    def perfectly_assessed(self, session, node):
        state = session.learning_states[node.concept_id]
        return (node.assessment_scope == 'direct' and state.status == 'mastered'
                and state.understanding_score == 1 and state.questions_answered > 0
                and state.correct_count == state.questions_answered
                and all(t.understanding_score == 1 and t.status == 'mastered' for t in state.target_states.values()))

    @staticmethod
    def mark_terminal(node, reason):
        node.granularity = 'narrow'
        node.child_candidates = []
        node.terminal_reason = reason
        node.terminal_confirmed = True
        node.expansion_error = None

    @tracked('miner', 'decomposition')
    async def prepare_children(self, session, node, purpose):
        with trace(session_id=session.session_id, concept_id=node.concept_id):
            result = await DecompositionAgent(self.providers[session.mode]).run(
                self.decomposition_request(session, node, purpose))
        return (await self.deduplicator.prepare(session, node, result)
                if session.exploration_mode == 'manual' and session.manual_flow == 'decomposition_first'
                   and purpose != 'display_mastered_concept'
                else PreparedDecomposition.model_construct(decomposition=result, proposals=[]))

    async def generate_children(self, session, node, purpose, prefetched=None):
        try:
            prepared = prefetched or await self.prepare_children(session, node, purpose)
        except LLMError as exc:
            node.expansion_error = f'下位項目の生成に失敗しました。{str(exc)}'[:1000]
            raise
        if not prepared.decomposition.child_nodes:
            self.mark_terminal(node, prepared.decomposition.root_concept.terminal_reason)
            return []
        if node.terminal_reason:
            node.terminal_reason = None
            node.terminal_confirmed = False
            node.granularity = (prepared.decomposition.root_concept.granularity
                                if prepared.decomposition.root_concept.granularity != 'narrow' else 'medium')
            node.child_candidates = prepared.decomposition.root_concept.child_candidates or [
                Candidate(concept_name=child.concept_name)
                for child in prepared.decomposition.child_nodes[:5]]
        children = []
        # The branch becomes visible only after all pre-display merge decisions finish.
        for incoming in prepared.decomposition.child_nodes:
            proposal = next((p for p in prepared.proposals if p.incoming_id == incoming.concept_id), None)
            child = self.deduplicator.apply(session, node, incoming, proposal)
            if purpose == 'display_mastered_concept' and child.concept_id == incoming.concept_id:
                child.assessment_scope = 'covered_by_parent'
            children.append(child)
        normalize_concept_references(session)
        node.expansion_kind = 'display_only' if purpose == 'display_mastered_concept' else 'diagnostic'
        node.expansion_error = None
        return children

    async def display_mastered_children(self, session, node):
        if (node.child_nodes or (node.terminal_reason and not node.child_candidates)
                or (session.config.max_depth is not None and node.depth >= session.config.max_depth)):
            return
        await self.generate_children(session, node, 'display_mastered_concept')

    def finish(self, session, reason):
        session.complete = True
        session.stop_reason = reason
        session.pending_question = None
        session.pending_review = None
        session.approved_expansion_id = None
        # Resolve statuses on the last answer too, without pretending budget exhaustion is evidence.
        for n in walk(session.knowledge_tree):
            st = session.learning_states[n.concept_id]
            if st.questions_answered >= session.config.max_questions_per_concept and st.status not in ('mastered', 'weak'):
                st.status = n.status = 'uncertain'
        self.record(session, Plan(action='complete', reason_code=reason))

    async def answer(self, session_id, request, on_progress=None):
        for attempt in range(3):
            try:
                return await self._answer_once(session_id, request, on_progress=on_progress)
            except ConflictError:
                if attempt == 2:
                    raise

    async def _answer_once(self, session_id, request, on_progress=None):
        session = self.repo.get(session_id)
        old = next((e for e in session.evidence if e.question_id == request.question_id), None)
        if old:
            if (old.user_answer, old.user_confidence) != (request.answer, request.user_confidence):
                raise ValueError('この問題には既に別の回答が保存されています。')
            if request.question_id in session.reassessment_question_ids:
                return self.public(session, old)
            error = await self.advance_safely(session)
            return self.public(session, old, error)
        is_reassessment = session.reassessment is not None
        question = session.reassessment.question if is_reassessment else session.pending_question
        if (session.complete and not is_reassessment) or not question or question.question_id != request.question_id:
            raise ValueError('現在表示されている問題に回答してください。')
        if question.choices and request.answer not in [c.choice_id for c in question.choices]:
            raise ValueError('選択肢から回答してください。')
        node = find(session, question.concept_id)
        await self._notify(on_progress, "EvaluationAgent", "evaluating", f"「{node.concept_name}」の解答を採点・解説を検証中...", concept_id=node.concept_id, concept_name=node.concept_name)
        async with self.jobs.track(session_id, 'evaluation', node.concept_id, 'answer'):
            with trace(session_id=session_id, concept_id=node.concept_id, assessment_target_id=question.assessment_target_id, question_id=question.question_id):
                evidence = await EvaluationAgent(self._provider(session.mode)).run(EvaluationInput(question=question, user_answer=request.answer,
                    user_confidence=request.user_confidence, answer_time_ms=request.answer_time_ms,
                    previous_evidence=[e for e in session.evidence if e.concept_id == node.concept_id and e.assessment_target_id == question.assessment_target_id]))
        # Grading waited for an LLM; retain changes committed by other operations.
        session = self.repo.get(session_id)
        old = next((item for item in session.evidence if item.question_id == request.question_id), None)
        if old:
            if (old.user_answer, old.user_confidence) != (request.answer, request.user_confidence):
                raise ValueError('この問題には既に別の回答が保存されています。')
            return self.public(session, old)
        node = find(session, question.concept_id)
        if node is None:
            raise ValueError('回答対象の項目は削除されました。')
        evidence.origin_map_id = session_id
        evidence.answered_at = datetime.now(timezone.utc).isoformat()
        evidence.understanding_before = session.learning_states[node.concept_id].understanding_score
        session.evidence.append(evidence)
        logger.info('session_id=%s concept_id=%s assessment_target_id=%s question_id=%s agent_name=evaluation grading=%s', session_id, node.concept_id, question.assessment_target_id, question.question_id, evidence.grading_method)
        state = update(node, session.evidence, session.config)
        evidence.understanding_after = state.understanding_score
        session.learning_states[node.concept_id] = state
        node.status = state.status
        is_correct = evidence.correctness == 'correct'
        await self._notify(on_progress, "EvaluationAgent", "graded", f"採点完了（{'正解' if is_correct else '要復習'}）", concept_id=node.concept_id, concept_name=node.concept_name)
        if state.status == 'weak' and session.first_weak_question is None:
            session.first_weak_question = len(session.evidence)
            session.first_weak_answer_time_ms = sum(e.answer_time_ms or 0 for e in session.evidence)
        if is_reassessment:
            session.reassessment = None
            # Display-only children must not keep claiming that their parent is perfect.
            if node.expansion_kind == 'display_only' and not self.perfectly_assessed(session, node):
                node.expansion_kind = 'diagnostic'
                for child in node.child_nodes:
                    child.assessment_scope = 'direct'
            if session.pending_review and session.pending_review.concept_id == node.concept_id:
                self.prepare_review(session, node)
            if session.exploration_mode == 'manual':
                if session.pending_question:
                    session.paused_questions[session.pending_question.concept_id] = session.pending_question
                    session.pending_question = None
                session.active_concept_id = None
            self._save(session)
            await self._notify(on_progress, "DiagnosticService", "ready", "採点結果と解説を開示", concept_id=node.concept_id, concept_name=node.concept_name)
            return self.public(session, evidence)
        if session.pending_question and session.pending_question.question_id == question.question_id:
            session.pending_question = None
        session.paused_questions.pop(question.concept_id, None)
        if session.exploration_mode == 'manual':
            if session.active_concept_id == question.concept_id:
                session.active_concept_id = None
            self._save(session)
            # 誤答時のみ下位項目へ深掘り（自動分解）
            is_mistake = (
                evidence.correctness != 'correct'
                or state.status in ('weak', 'learning')
                or (state.understanding_score is not None and state.understanding_score < 0.7)
            )
            if is_mistake and self.can_expand(session, node):
                await self._notify(on_progress, "DecompositionAgent", "deepening", f"「{node.concept_name}」の弱点を克服するための下位概念を分析中...", concept_id=node.concept_id, concept_name=node.concept_name)
                if request.immediate_feedback:
                    # 即座に解説を返すため、分解はバックグラウンド非同期タスクで実行
                    async def _bg_decompose():
                        try:
                            await self.decompose_concept(session_id, node.concept_id, background=True)
                        except Exception as exc:
                            logger.warning('session_id=%s concept_id=%s mistake_decomposition_failed=%s',
                                           session_id, node.concept_id, type(exc).__name__)
                    try:
                        loop = asyncio.get_running_loop()
                        loop.create_task(_bg_decompose())
                    except RuntimeError:
                        pass
                else:
                    # テスト等の同期待ち要求時は同期実行
                    try:
                        await self._decompose_concept_once(session_id, node.concept_id, background=False)
                        session = self.repo.get(session_id)
                    except Exception as exc:
                        logger.warning('session_id=%s concept_id=%s mistake_decomposition_failed=%s',
                                       session_id, node.concept_id, type(exc).__name__)
            await self._notify(on_progress, "DiagnosticService", "ready", "採点結果と解説を開示")
            return self.public(session, evidence)
        # Keep the current concept at the head until the policy finishes its assessment.
        # Target coverage may change within this concept; sibling concepts wait.
        self._save(session)  # Answer is durable before any next-generation call.
        if request.immediate_feedback:
            loop = asyncio.get_running_loop()
            loop.create_task(self.advance_safely(session))
            await self._notify(on_progress, "DiagnosticService", "ready", "採点結果と解説を開示")
            return self.public(session, evidence)
        error = await self.advance_safely(session)
        await self._notify(on_progress, "DiagnosticService", "ready", "採点結果と解説を開示")
        return self.public(session, evidence, error)

    def can_expand(self, session, node):
        # A model may omit child_candidates even for an obviously non-terminal broad/medium concept.
        # Treat granularity as a fallback so existing sessions can still request their next layer.
        if session.exploration_mode == 'manual' and session.manual_flow == 'decomposition_first':
            return bool(node.assessment_scope == 'direct' and node.depth > 0 and not node.child_nodes and
                        not any(edge.source == node.concept_id and edge.relation == 'part' for edge in session.concept_edges) and
                        not (node.terminal_confirmed and node.terminal_reason and not node.child_candidates))
        expandable_shape = node.child_candidates or node.granularity in ('broad', 'medium') or session.mode == 'demo'
        return bool(node.assessment_scope == 'direct' and expandable_shape and not node.child_nodes and
                    not (node.terminal_reason and not node.child_candidates) and
                    (session.config.max_depth is None or node.depth < session.config.max_depth))

    def prepare_review(self, session, node):
        state = session.learning_states[node.concept_id]
        if state.questions_answered >= session.config.max_questions_per_concept and state.status not in ('weak', 'mastered'):
            state.status = node.status = 'uncertain'
        demonstrated, weak, unresolved = [], [], []
        for target in node.assessment_targets:
            ts = state.target_states[target.target_id]
            if ts.status == 'mastered':
                demonstrated.append(target.description)
            elif ts.status == 'weak':
                weak.append(f'「{target.description}」という能力の確認でつまずきが見られます。')
            else:
                unresolved.append(target.description)
        missing = [text for e in session.evidence if e.concept_id == node.concept_id and e.correctness != 'ungradable'
                   for text in e.missing_knowledge]
        weak.extend(text for text in dict.fromkeys(missing) if text not in weak)
        expandable = self.can_expand(session, node)
        summary = (f'「{node.concept_name}」の回答から、以下を弱点の候補として整理しました。'
                   if state.status == 'weak' else
                   f'「{node.concept_name}」は回答だけではまだ原因を絞り込めていません。確定できていない点も含めて整理しました。')
        session.pending_review = FindingsReview(concept_id=node.concept_id, concept_name=node.concept_name,
            layer=node.depth + 1, reason_code='USER_REVIEW_REQUIRED', summary=summary,
            demonstrated=demonstrated, weak_candidates=weak, unresolved=unresolved,
            evidence_ids=state.evidence_ids, diagnostic_confidence=state.diagnostic_confidence,
            unassessed_concepts=sum(session.learning_states[n.concept_id].questions_answered == 0
                                    for n in walk(session.knowledge_tree) if n.depth > 0 and n.assessment_scope == 'direct'),
            can_expand=expandable,
            next_step=(f'第{node.depth + 2}層へ分解し、原因をより細かく確認します。' if expandable else
                       'この項目には追加の分解候補がありません。残りの項目を確認し、残りがなければ原因未特定として終了します。'))

    async def review(self, session_id, request):
        session = self.repo.get(session_id)
        if session.reassessment:
            raise ValueError('追加確認に回答するか、中止してから続けてください。')
        previous = next((r for r in session.review_history if r.review.review_id == request.review_id), None)
        if previous:
            if previous.decision != request.decision:
                raise ValueError('この分析結果への選択は既に保存されています。')
            return self.public(session)
        review = session.pending_review
        if session.complete or not review or review.review_id != request.review_id:
            raise ValueError('現在表示されている分析結果に回答してください。')
        session.review_history.append(ReviewDecision(review=review, decision=request.decision, questions_answered=len(session.evidence)))
        session.pending_review = None
        if request.decision == 'understood_gap':
            if session.exploration_mode == 'focused':
                self.finish(session, 'USER_UNDERSTOOD_GAP')
                self._save(session)
                return self.public(session)
            # In comprehensive mode, satisfaction closes this branch, not the rest of the map.
            session.queue = [cid for cid in session.queue if cid != review.concept_id]
        elif review.can_expand:
            session.approved_expansion_id = review.concept_id
        else:
            session.queue = [cid for cid in session.queue if cid != review.concept_id]
        if review.concept_id not in session.completed_concepts:
            session.completed_concepts.append(review.concept_id)
        # Persist the choice before the LLM call; failed expansion is resumable.
        self._save(session)
        error = await self.advance_safely(session)
        return self.public(session, error=error)

    async def expand_node(self, session, node):
        if node.child_nodes:
            return
        if session.complete or (session.config.max_total_questions is not None and len(session.evidence) >= session.config.max_total_questions):
            raise ValueError('終了した診断は追加展開できません。')
        approved = session.approved_expansion_id == node.concept_id
        if node.depth >= session.config.review_min_depth and not approved:
            raise ValueError('分析結果を確認してから、さらに探索するか選んでください。')
        if node.assessment_scope != 'direct' or not approved or not self.can_expand(session, node):
            raise ValueError('この項目はこれ以上分解できません。')
        if self.perfectly_assessed(session, node):
            raise ValueError('理解度100%の項目の子は表示のみで、追加出題しません。')
        children = await self.generate_children(session, node,
            'expand_weak_concept' if node.status == 'weak' and session.exploration_mode == 'focused' else 'expand_concept')
        session.queue = [n.concept_id for n in children] + [c for c in session.queue if c != node.concept_id]
        if node.concept_id not in session.completed_concepts:
            session.completed_concepts.append(node.concept_id)

    async def expand(self, session_id, concept_id):
        session = self.repo.get(session_id)
        node = find(session, concept_id)
        if node is None:
            raise KeyError(concept_id)
        # Do not invalidate another concept's pending question with manual expansion.
        if session.pending_question or session.pending_review or session.reassessment:
            raise ValueError('現在の問題に回答してから追加展開してください。')
        await self.expand_node(session, node)
        error = await self.advance_safely(session)
        return self.public(session, error=error)

    async def resume(self, session_id):
        session = self.repo.get(session_id)
        error = await self.advance_safely(session)
        return self.public(session, error=error)

    def decomposition_statuses(self, session, runtime=None):
        if session.exploration_mode != 'manual' or session.manual_flow != 'decomposition_first' or session.complete:
            return {}
        cached = self.repo.prefetch_statuses(session.session_id)
        statuses = {}
        for node in walk(session.knowledge_tree):
            if not self.can_expand(session, node):
                continue
            task = self._prefetch_tasks.get((session.session_id, node.concept_id))
            if task is not None and not task.done():
                status = 'generating' if (session.session_id, node.concept_id) in self._prefetch_running else 'queued'
            elif cached.get(node.concept_id) == 'ready':
                status = 'ready'
            elif cached.get(node.concept_id) == 'failed' or node.expansion_error:
                status = 'failed'
            else:
                status = 'available'
            statuses[node.concept_id] = status
        runtime = runtime or self.jobs.snapshot(session.session_id)
        for job in runtime['jobs']:
            if job['source'] not in ('prefetch', 'decomposition'):
                continue
            if job['role'] == 'miner' and job['concept_id'] in statuses and job['status'] in ('queued', 'running'):
                statuses[job['concept_id']] = 'generating' if job['status'] == 'running' else 'queued'
            elif job['role'] == 'miner' and job['concept_id'] in statuses and job['status'] in ('failed', 'cancelled') and statuses[job['concept_id']] != 'ready':
                statuses[job['concept_id']] = 'failed'
        return statuses

    def question_statuses(self, session, runtime):
        used = {q.question_id for q in session.questions}
        current = session.reassessment.question if session.reassessment else session.pending_question
        result = {}
        for node in walk(session.knowledge_tree):
            if node.depth == 0:
                continue
            cid = node.concept_id
            ready = {q.question_id for q in session.question_pool.get(cid, []) if q.question_id not in used}
            if current and current.concept_id == cid:
                ready.add(current.question_id)
            if cid in session.paused_questions:
                ready.add(session.paused_questions[cid].question_id)
            jobs = [j for j in runtime['jobs'] if j['role'] == 'question' and j['source'] == 'question_generation' and j['concept_id'] == cid]
            last = next((j for j in reversed(jobs) if j['status'] in ('running', 'queued')),
                        runtime.get('question_states', {}).get(cid, jobs[-1] if jobs else None))
            state = 'ready' if ready else ('generating' if last['status'] == 'running' else last['status']) if last and last['status'] in ('running', 'queued', 'failed', 'cancelled') else 'available'
            result[cid] = {'status': state, 'unanswered_count': len(ready),
                'answered_count': sum(e.concept_id == cid for e in session.evidence),
                'job_id': last['job_id'] if last else None,
                'error': last['error'] if last and state == 'failed' else None,
                'retryable': state in ('failed', 'cancelled')}
        return result

    def public(self, session, evaluation=None, error=None):
        if session.session_id in self._cost_tracker:
            session.cost_summary.merge(self._cost_tracker[session.session_id])
            self._cost_tracker[session.session_id] = session.cost_summary.model_copy(deep=True)
        runtime = self.jobs.snapshot(session.session_id)
        # Never disclose pending or unanswered answer keys/distractor mappings.
        question = session.reassessment.question if session.reassessment else session.pending_question
        pending = question.model_dump(exclude={'expected_answer', 'answer_explanation', 'grading_type', 'diagnostic_mapping'}) if question else None
        answered = {e.question_id for e in session.evidence}
        history = [q.model_dump() for q in session.questions if q.question_id in answered]
        canonical_refs = self.repo.canonical_refs(session.session_id)
        for ref in canonical_refs.values():
            ref['other_map_titles'] = []
            for map_id in ref['other_maps']:
                try:
                    ref['other_map_titles'].append(self.repo.get_map(map_id)['title'])
                except KeyError:
                    continue
        return {'session_id': session.session_id, 'theme': session.theme, 'domain_context': session.domain_context,
            'mode': session.mode, 'exploration_mode': session.exploration_mode,
            'manual_flow': session.manual_flow, 'decomposition_max_depth': None if session.manual_flow == 'decomposition_first' else session.decomposition_max_depth,
            'initial_visible_depth': session.initial_visible_depth,
            'initial_generation_complete': session.initial_generation_complete,
            'initial_root_pending': session.initial_root_pending,
            'decomposition_statuses': self.decomposition_statuses(session, runtime),
            'question_statuses': self.question_statuses(session, runtime),
            'agent_runtime': {key: value for key, value in runtime.items() if key != 'question_states'},
            'deleted_concept_ids': session.deleted_concept_ids,
            'agent_capacities': self.jobs.capacities,
            'cross_map_active_count': sum(j['source'] == 'propose_other_maps' and j['status'] == 'running' for j in runtime['jobs']),
            'decomposition_depth_reason': None if session.manual_flow == 'decomposition_first' else session.decomposition_depth_reason,
            'focused_path': session.focused_path, 'answer_format': session.answer_format, 'allowed_question_types': session.allowed_question_types,
            'reassessment_concept_id': session.reassessment.concept_id if session.reassessment else None,
            'active_concept_id': session.reassessment.concept_id if session.reassessment else session.active_concept_id, 'paused_concept_ids': list(session.paused_questions),
            'awaiting_selection': not session.reassessment and session.exploration_mode == 'manual' and not session.complete and not session.pending_question
                and session.active_concept_id is None,
            'created_at': session.created_at, 'revision': session.revision,
            'knowledge_tree': session.knowledge_tree.model_dump(),
            'concept_edges': [edge.model_dump() for edge in session.concept_edges],
            'concept_redirects': session.concept_redirects,
            'canonical_refs': canonical_refs,
            'cross_map_matching': any(not task.done() for task in self._cross_map_tasks.get(session.session_id, ())),
            'learning_states': conversation_learning_states(session),
            'chat': {**session.chat.model_dump(exclude={'routing_records', 'assessment_records'}),
                'observations': [public_observation(item) for item in session.chat.observations]},
            'conversation_assessed_concept_ids': sorted(conversation_assessed_ids(session)),
            'self_assessments': {k: v.model_dump() for k, v in session.self_assessments.items()},
            'understanding_summaries': summaries(session),
            'pending_review': session.pending_review.model_dump() if session.pending_review and not session.reassessment else None,
            'review_history': [r.model_dump() for r in session.review_history],
            'next_question': pending, 'next_action': session.next_action.model_dump() if session.next_action else None,
            'evaluation': evaluation.model_dump() if evaluation else None,
            'updated_learning_state': session.learning_states[evaluation.concept_id].model_dump() if evaluation else None,
            'evidence': [e.model_dump() for e in session.evidence], 'question_history': history,
            'policy_history': [p.model_dump() for p in session.policy_history],
            'questions_answered': len(session.evidence), 'max_total_questions': session.config.max_total_questions,
            'cost_summary': session.cost_summary.model_dump() if session.cost_summary else SessionCost().model_dump(),
            'complete': session.complete and not bool(session.reassessment), 'stop_reason': session.stop_reason if not session.reassessment else None, 'error': error,
            'metrics': {'display_only_concepts': sum(n.assessment_scope == 'covered_by_parent' for n in walk(session.knowledge_tree)),
                'unassessed_concepts': sum(session.learning_states[n.concept_id].questions_answered == 0 for n in walk(session.knowledge_tree) if n.depth > 0 and n.assessment_scope == 'direct'),
                'first_weak_question': session.first_weak_question,
                'first_weak_answer_time_ms': session.first_weak_answer_time_ms,
                'written_answers': sum(q.question_type not in ('multiple_choice', 'yes_no') for q in session.questions if q.question_id in answered),
                'ungradable_answers': sum(e.correctness == 'ungradable' for e in session.evidence),
                'answer_time_ms': sum(e.answer_time_ms or 0 for e in session.evidence),
                'assessed_concepts': sum(s.questions_answered > 0 for s in session.learning_states.values()),
                'weak_concepts': sum(s.status == 'weak' for s in session.learning_states.values())}}
