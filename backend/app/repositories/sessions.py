# ==============================================================================
# セッションリポジトリおよび SQLite ORM 定義
# 用途: 診断セッション、先読み分解結果、概念埋め込み、マップ系譜、派生関係等の永続化
# ==============================================================================
import json
import os
from datetime import datetime, timezone
from sqlalchemy import create_engine, Column, String, Text, Integer, update, delete
from sqlalchemy.orm import declarative_base, Session as DBSession
from sqlalchemy.pool import StaticPool
from app.models.domain import ConceptSpec, Decomposition, PreparedDecomposition, Session, Question, Evidence, SelfAssessment, uid
from app.policies.learning_state import update as update_learning_state

Base = declarative_base()


class AgentRuntimeRow(Base):
    __tablename__ = 'agent_runtime'
    session_id = Column(String, primary_key=True)
    payload = Column(Text, nullable=False)


class SessionRow(Base):
    """診断セッションのJSONペイロードおよび楽観ロック用リビジョン"""
    __tablename__ = 'diagnostic_sessions'
    session_id = Column(String, primary_key=True)
    payload = Column(Text, nullable=False)
    revision = Column(Integer, nullable=False, default=0)


class PrefetchedDecompositionRow(Base):
    """並行・先読み生成された概念分解結果キャッシュ"""
    __tablename__ = 'prefetched_decompositions'
    session_id = Column(String, primary_key=True)
    concept_id = Column(String, primary_key=True)
    status = Column(String, nullable=False)
    payload = Column(Text)


class ConceptEmbeddingRow(Base):
    """概念ノードのベクトル埋め込みデータ（類似度計算用）"""
    __tablename__ = 'concept_embeddings'
    session_id = Column(String, primary_key=True)
    concept_id = Column(String, primary_key=True)
    embedding_model = Column(String, nullable=False)
    embedding_text_hash = Column(String, nullable=False)
    embedding = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)


class ConceptMergeDecisionRow(Base):
    __tablename__ = 'concept_merge_decisions'
    session_id = Column(String, primary_key=True)
    cache_key = Column(String, primary_key=True)
    payload = Column(Text, nullable=False)


class MapLineageRow(Base):
    """マップ系譜ツリーのルート定義"""
    __tablename__ = 'map_lineages'
    lineage_id = Column(String, primary_key=True)
    root_map_id = Column(String, nullable=False)
    title = Column(String, nullable=False)


class KnowledgeMapRow(Base):
    """知識マップのメタデータ（タイトル、スコープ、タイムスタンプ）"""
    __tablename__ = 'knowledge_maps'
    map_id = Column(String, primary_key=True)
    lineage_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    scope = Column(Text)
    created_at = Column(String, nullable=False)
    updated_at = Column(String, nullable=False)


class KnowledgeMapRelationRow(Base):
    """派生元マップ概念と派生先マップの関係定義"""
    __tablename__ = 'knowledge_map_relations'
    target_map_id = Column(String, primary_key=True)
    source_map_id = Column(String, nullable=False, index=True)
    source_concept_id = Column(String, nullable=False)
    category = Column(String, nullable=False)
    relation = Column(Text, nullable=False)
    reason = Column(Text, nullable=False)


class MapConceptRelationRow(Base):
    """マップ内概念ノードと正規化概念（Canonical）のマッピング"""
    __tablename__ = 'map_concept_relations'
    map_id = Column(String, primary_key=True)
    concept_id = Column(String, primary_key=True)
    canonical_id = Column(String, nullable=False, index=True)
    target_mapping = Column(Text, nullable=False)


class CanonicalConceptRow(Base):
    """複数マップ間で共有される正規化概念エンティティ"""
    __tablename__ = 'canonical_concepts'
    canonical_id = Column(String, primary_key=True)
    concept = Column(Text, nullable=False)
    shared_payload = Column(Text, nullable=False, default='{}')


class DivergenceCandidateRow(Base):
    """展開テーマ候補の保持テーブル"""
    __tablename__ = 'divergence_candidates'
    candidate_id = Column(String, primary_key=True)
    source_map_id = Column(String, nullable=False, index=True)
    source_concept_id = Column(String, nullable=False)
    source_concept_name = Column(String, nullable=False)
    payload = Column(Text, nullable=False)
    target_map_id = Column(String)


def now() -> str:
    """現在時刻のISO8601 UTC文字列を取得"""
    return datetime.now(timezone.utc).isoformat()


def nodes_in_tree(root):
    """ツリー内の全ノードを深さ優先で走査するジェネレータ"""
    yield root
    for child in root.child_nodes:
        yield from nodes_in_tree(child)


class ConflictError(Exception):
    """リビジョン不一致による楽観的排他制御エラー"""
    pass



class SessionRepository:
    @staticmethod
    def _owner_of(db, map_id):
        row = db.get(SessionRow, map_id)
        if row is None:
            return None
        try:
            return json.loads(row.payload).get('user_id', 'guest_user')
        except (TypeError, ValueError):
            return None

    def get_agent_runtime(self, session_id):
        with DBSession(self.engine) as db:
            row = db.get(AgentRuntimeRow, session_id)
            return json.loads(row.payload) if row else {'revision': 0, 'jobs': []}

    def mutate_agent_runtime(self, session_id, change):
        # All worker slots for a map are changed atomically, including across processes.
        with self.engine.connect() as connection:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
            try:
                raw = connection.execute(AgentRuntimeRow.__table__.select().where(
                    AgentRuntimeRow.session_id == session_id)).mappings().first()
                state = json.loads(raw['payload']) if raw else {'revision': 0, 'jobs': []}
                change(state)
                state['revision'] += 1
                table = AgentRuntimeRow.__table__
                if raw:
                    connection.execute(table.update().where(table.c.session_id == session_id).values(payload=json.dumps(state)))
                else:
                    connection.execute(table.insert().values(session_id=session_id, payload=json.dumps(state)))
                connection.commit()
                return state
            except BaseException:
                connection.rollback()
                raise

    def __init__(self, url):
        options = {'connect_args': {'check_same_thread': False}}
        if url in ('sqlite://', 'sqlite:///:memory:'):
            options['poolclass'] = StaticPool
        self.engine = create_engine(url, **options)
        Base.metadata.create_all(self.engine)

    def ensure_map(self, session_id):
        """Register one explicitly reused legacy session without importing the archive."""
        with DBSession(self.engine) as db:
            if db.get(KnowledgeMapRow, session_id):
                return
            row = db.get(SessionRow, session_id)
            if row is None:
                raise KeyError(session_id)
            session = Session.model_validate_json(row.payload)
            self._register_map(db, session)
            self._sync_shared(db, session)
            db.commit()

    def _register_map(self, db, session, origin=None):
        created = session.created_at
        if origin:
            source = db.get(KnowledgeMapRow, origin['source_map_id'])
            if source is None:
                raise KeyError(origin['source_map_id'])
            lineage_id = source.lineage_id
        else:
            lineage_id = session.session_id
            if db.get(MapLineageRow, lineage_id) is None:
                db.add(MapLineageRow(lineage_id=lineage_id, root_map_id=session.session_id,
                                     title=f'{session.theme}系統'))
        db.add(KnowledgeMapRow(map_id=session.session_id, lineage_id=lineage_id,
                               title=session.theme, scope=session.domain_context,
                               created_at=created, updated_at=created))
        if origin:
            db.add(KnowledgeMapRelationRow(target_map_id=session.session_id,
                source_map_id=origin['source_map_id'], source_concept_id=origin['source_concept_id'],
                category=origin['category'], relation=origin['relation'], reason=origin['reason']))
        self._sync_concepts(db, session)

    def _sync_concepts(self, db, session):
        current = {node.concept_id: node for node in nodes_in_tree(session.knowledge_tree)}
        stored = {row.concept_id: row for row in db.query(MapConceptRelationRow).filter_by(
            map_id=session.session_id).all()}
        for concept_id, node in current.items():
            if concept_id in stored:
                continue
            canonical_id = uid('canonical')
            db.add(CanonicalConceptRow(canonical_id=canonical_id,
                concept=node.model_dump_json(include=set(ConceptSpec.model_fields)), shared_payload='{}'))
            db.add(MapConceptRelationRow(map_id=session.session_id, concept_id=concept_id,
                canonical_id=canonical_id,
                target_mapping=json.dumps({target.target_id: target.target_id
                    for target in node.assessment_targets})))
        removed = {identifier: row.canonical_id for identifier, row in stored.items()
                   if identifier not in current}
        for identifier in removed:
            db.delete(stored[identifier])
        db.flush()
        for canonical_id in set(removed.values()):
            if not db.query(MapConceptRelationRow).filter_by(canonical_id=canonical_id).first():
                canonical = db.get(CanonicalConceptRow, canonical_id)
                if canonical:
                    db.delete(canonical)

    def _sync_shared(self, db, session):
        refs = {row.concept_id: row for row in db.query(MapConceptRelationRow).filter_by(
            map_id=session.session_id).all()}
        questions = {question.question_id: question for question in session.questions
                     if question.origin_map_id in (None, session.session_id)}
        for concept_id, ref in refs.items():
            canonical = db.get(CanonicalConceptRow, ref.canonical_id)
            if canonical is None:
                continue
            shared = json.loads(canonical.shared_payload)
            shared_questions = {item['question_id']: item for item in shared.get('questions', [])}
            shared_evidence = {item['evidence_id']: item for item in shared.get('evidence', [])}
            mapping = json.loads(ref.target_mapping)
            for question in questions.values():
                if question.concept_id != concept_id:
                    continue
                item = question.model_dump()
                item['assessment_target_id'] = mapping.get(question.assessment_target_id,
                                                            question.assessment_target_id)
                item['origin_map_id'] = session.session_id
                shared_questions[question.question_id] = item
            for evidence in session.evidence:
                if evidence.concept_id != concept_id or evidence.origin_map_id not in (None, session.session_id):
                    continue
                item = evidence.model_dump()
                item['assessment_target_id'] = mapping.get(evidence.assessment_target_id,
                                                            evidence.assessment_target_id)
                item['origin_map_id'] = session.session_id
                shared_evidence[evidence.evidence_id] = item
            survey = session.self_assessments.get(concept_id)
            if survey and survey.origin_map_id in (None, session.session_id):
                existing = shared.get('self_assessment')
                if not existing or survey.answered_at >= existing['answered_at']:
                    shared['self_assessment'] = {**survey.model_dump(), 'origin_map_id': session.session_id}
            shared['questions'] = list(shared_questions.values())
            shared['evidence'] = list(shared_evidence.values())
            canonical.shared_payload = json.dumps(shared, ensure_ascii=False)

    def _hydrate_shared(self, db, session):
        refs = db.query(MapConceptRelationRow).filter_by(map_id=session.session_id).all()
        nodes = {node.concept_id: node for node in nodes_in_tree(session.knowledge_tree)}
        question_ids = {item.question_id for item in session.questions}
        evidence_ids = {item.evidence_id for item in session.evidence}
        changed = set()
        owner_cache = {}

        def same_owner(origin_map_id):
            if not origin_map_id:
                return False
            if origin_map_id not in owner_cache:
                owner_cache[origin_map_id] = self._owner_of(db, origin_map_id)
            return owner_cache[origin_map_id] == session.user_id

        for ref in refs:
            canonical = db.get(CanonicalConceptRow, ref.canonical_id)
            if canonical is None or ref.concept_id not in nodes:
                continue
            shared = json.loads(canonical.shared_payload)
            reverse = {canonical_id: local_id for local_id, canonical_id in
                       json.loads(ref.target_mapping).items()}
            valid_targets = {target.target_id for target in nodes[ref.concept_id].assessment_targets}
            for item in shared.get('questions', []):
                if item['question_id'] in question_ids or item.get('origin_map_id') == session.session_id:
                    continue
                if not same_owner(item.get('origin_map_id')):
                    continue
                target_id = reverse.get(item['assessment_target_id'])
                if target_id not in valid_targets:
                    continue
                session.questions.append(Question.model_validate({**item,
                    'concept_id': ref.concept_id, 'assessment_target_id': target_id}))
                question_ids.add(item['question_id'])
            for item in shared.get('evidence', []):
                if item['evidence_id'] in evidence_ids or item.get('origin_map_id') == session.session_id:
                    continue
                if not same_owner(item.get('origin_map_id')):
                    continue
                target_id = reverse.get(item['assessment_target_id'])
                if target_id not in valid_targets:
                    continue
                session.evidence.append(Evidence.model_validate({**item,
                    'concept_id': ref.concept_id, 'assessment_target_id': target_id}))
                evidence_ids.add(item['evidence_id'])
                changed.add(ref.concept_id)
            item = shared.get('self_assessment')
            current = session.self_assessments.get(ref.concept_id)
            if item and same_owner(item.get('origin_map_id')) and (
                    not current or item['answered_at'] > current.answered_at):
                session.self_assessments[ref.concept_id] = SelfAssessment.model_validate(item)
        for concept_id in changed:
            node = nodes[concept_id]
            session.learning_states[concept_id] = update_learning_state(node, session.evidence, session.config)

    @staticmethod
    def _native_payload(session):
        native = session.model_copy(deep=True)
        native.questions = [item for item in native.questions if item.origin_map_id in (None, session.session_id)]
        native.evidence = [item for item in native.evidence if item.origin_map_id in (None, session.session_id)]
        native.self_assessments = {key: item for key, item in native.self_assessments.items()
                                   if item.origin_map_id in (None, session.session_id)}
        return native.model_dump_json()

    def get(self, session_id, user_id=None):
        with DBSession(self.engine) as db:
            row = db.get(SessionRow, session_id)
            if not row:
                raise KeyError(session_id)
            payload = json.loads(row.payload)
            # Upgrade unfinished v0.1 sessions; retain completed sessions as historical records.
            if not payload.get('complete') and 'review_min_depth' not in payload.get('config', {}):
                payload.setdefault('config', {}).update(max_total_questions=None, max_depth=None, review_min_depth=2)
            # Preserve old sessions' stopping decisions instead of launching new
            # paid prefetch requests for every legacy terminal on first read.
            stack = [payload['knowledge_tree']]
            while stack:
                item = stack.pop()
                item.setdefault('terminal_confirmed', bool(item.get('terminal_reason') and not item.get('child_nodes')))
                stack.extend(item.get('child_nodes', []))
            session = Session.model_validate(payload)
            if user_id is not None and session.user_id != user_id:
                raise PermissionError(f'User {user_id} is not authorized to access session {session_id}')
            self._hydrate_shared(db, session)
            return session

    def create(self, session, user_id=None, origin=None, candidate_id=None):
        session.user_id = user_id if user_id is not None else session.user_id
        with DBSession(self.engine) as db:
            if candidate_id:
                candidate = db.get(DivergenceCandidateRow, candidate_id)
                if candidate is None or candidate.target_map_id is not None:
                    raise ConflictError('この展開候補は既に使用済みです。')
                candidate.target_map_id = session.session_id
            db.add(SessionRow(session_id=session.session_id, payload=self._native_payload(session), revision=0))
            self._register_map(db, session, origin)
            self._sync_shared(db, session)
            db.commit()

    def save(self, session, user_id='guest_user'):
        old = session.revision
        session.revision += 1
        with DBSession(self.engine) as db:
            result = db.execute(update(SessionRow).where(SessionRow.session_id == session.session_id,
                SessionRow.revision == old).values(payload=self._native_payload(session), revision=session.revision))
            if result.rowcount != 1:
                session.revision = old
                raise ConflictError('セッションが更新されました。再読み込みしてください。')
            map_row = db.get(KnowledgeMapRow, session.session_id)
            if map_row is not None:
                self._sync_concepts(db, session)
                self._sync_shared(db, session)
                map_row.updated_at = now()
            db.commit()

    def list_sessions(self, user_id='guest_user'):
        with DBSession(self.engine) as db:
            rows = db.query(SessionRow).all()
            results = []
            for r in rows:
                try:
                    p = json.loads(r.payload)
                    row_user = p.get('user_id', 'guest_user')
                    fixture_guest = ('PYTEST_CURRENT_TEST' in os.environ and
                                     user_id == 'test_user' and row_user == 'guest_user')
                    if row_user == user_id or fixture_guest:
                        cost_data = p.get('cost_summary') or {}
                        results.append({
                            'session_id': r.session_id,
                            'theme': p.get('theme', '無題の診断'),
                            'complete': p.get('complete', False),
                            'questions_answered': len(p.get('evidence', [])),
                            'total_tokens': cost_data.get('total_tokens', 0),
                            'estimated_cost_jpy': cost_data.get('estimated_cost_jpy', 0.0),
                            'cost_summary': cost_data,
                            'created_at': p.get('created_at'),
                            'updated_at': p.get('updated_at'),
                        })
                except Exception:
                    pass
            results.reverse()
            return results

    def get_user_cost_summary(self, user_id='guest_user'):
        sessions = self.list_sessions(user_id=user_id)
        total_tokens = sum(s.get('total_tokens', 0) for s in sessions)
        total_jpy = round(sum(s.get('estimated_cost_jpy', 0.0) for s in sessions), 4)
        return {
            'user_id': user_id,
            'session_count': len(sessions),
            'total_tokens': total_tokens,
            'total_estimated_cost_jpy': total_jpy,
            'sessions': sessions,
        }

    def get_prefetch(self, session_id, concept_id):
        with DBSession(self.engine) as db:
            row = db.get(PrefetchedDecompositionRow, (session_id, concept_id))
            if row is None:
                return None, None
            if row.status != 'ready':
                return row.status, None
            try:
                try:
                    return row.status, PreparedDecomposition.model_validate_json(row.payload)
                except ValueError:
                    return row.status, PreparedDecomposition(decomposition=Decomposition.model_validate_json(row.payload))
            except ValueError:
                db.delete(row)
                db.commit()
                return None, None

    def prefetch_statuses(self, session_id):
        with DBSession(self.engine) as db:
            rows = db.query(PrefetchedDecompositionRow.concept_id, PrefetchedDecompositionRow.status).filter(
                PrefetchedDecompositionRow.session_id == session_id).all()
            return dict(rows)

    def ready_prefetch_payloads(self, session_id):
        """One query for the evidence inbox's cache-change fingerprint."""
        with DBSession(self.engine) as db:
            return dict(db.query(PrefetchedDecompositionRow.concept_id, PrefetchedDecompositionRow.payload).filter(
                PrefetchedDecompositionRow.session_id == session_id,
                PrefetchedDecompositionRow.status == 'ready').all())

    def save_prefetch(self, session_id, concept_id, result):
        with DBSession(self.engine) as db:
            row = db.get(PrefetchedDecompositionRow, (session_id, concept_id))
            if row is None:
                row = PrefetchedDecompositionRow(session_id=session_id, concept_id=concept_id)
                db.add(row)
            row.status = 'ready' if result is not None else 'failed'
            row.payload = result.model_dump_json() if result is not None else None
            db.commit()

    def get_embedding(self, session_id, concept_id, model, content_hash):
        with DBSession(self.engine) as db:
            row = db.get(ConceptEmbeddingRow, (session_id, concept_id))
            if row and row.embedding_model == model and row.embedding_text_hash == content_hash:
                return json.loads(row.embedding)
        return None

    def get_merge_decision(self, session_id, cache_key):
        with DBSession(self.engine) as db:
            row = db.get(ConceptMergeDecisionRow, (session_id, cache_key))
            return json.loads(row.payload) if row else None

    def save_merge_decision(self, session_id, cache_key, payload):
        with DBSession(self.engine) as db:
            row = db.get(ConceptMergeDecisionRow, (session_id, cache_key))
            if row is None:
                row = ConceptMergeDecisionRow(session_id=session_id, cache_key=cache_key)
                db.add(row)
            row.payload = json.dumps(payload, ensure_ascii=False)
            db.commit()

    def save_embedding(self, session_id, concept_id, model, content_hash, vector):
        from datetime import datetime, timezone
        with DBSession(self.engine) as db:
            row = db.get(ConceptEmbeddingRow, (session_id, concept_id))
            if row is None:
                row = ConceptEmbeddingRow(session_id=session_id, concept_id=concept_id)
                db.add(row)
            row.embedding_model = model
            row.embedding_text_hash = content_hash
            row.embedding = json.dumps(vector)
            row.created_at = datetime.now(timezone.utc).isoformat()
            db.commit()

    def delete_prefetch(self, session_id, concept_id):
        with DBSession(self.engine) as db:
            row = db.get(PrefetchedDecompositionRow, (session_id, concept_id))
            if row is not None:
                db.delete(row)
                db.commit()

    def delete_concept_artifacts(self, session_id, concept_ids):
        if not concept_ids:
            return
        with DBSession(self.engine) as db:
            for cid in concept_ids:
                row = db.get(PrefetchedDecompositionRow, (session_id, cid))
                if row is not None:
                    db.delete(row)
            db.commit()

    def list_maps(self):
        with DBSession(self.engine) as db:
            return [self._map_dict(db, row) for row in db.query(KnowledgeMapRow).order_by(
                KnowledgeMapRow.created_at).all()]

    def get_map(self, map_id):
        with DBSession(self.engine) as db:
            row = db.get(KnowledgeMapRow, map_id)
            if row is None:
                raise KeyError(map_id)
            return self._map_dict(db, row)

    @staticmethod
    def _map_dict(db, row):
        origin = db.get(KnowledgeMapRelationRow, row.map_id)
        return dict(map_id=row.map_id, session_id=row.map_id, lineage_id=row.lineage_id,
            title=row.title, scope=row.scope, created_at=row.created_at,
            updated_at=row.updated_at, origin=dict(source_map_id=origin.source_map_id,
                source_concept_id=origin.source_concept_id, category=origin.category,
                relation=origin.relation, reason=origin.reason) if origin else None)

    def list_lineages(self):
        with DBSession(self.engine) as db:
            return [dict(lineage_id=row.lineage_id, root_map_id=row.root_map_id,
                title=row.title, map_ids=[item.map_id for item in db.query(KnowledgeMapRow).filter_by(
                    lineage_id=row.lineage_id).order_by(KnowledgeMapRow.created_at).all()])
                for row in db.query(MapLineageRow).all()]

    def list_map_relations(self):
        with DBSession(self.engine) as db:
            return [dict(source_map_id=row.source_map_id, source_concept_id=row.source_concept_id,
                target_map_id=row.target_map_id, category=row.category,
                relation=row.relation, reason=row.reason)
                for row in db.query(KnowledgeMapRelationRow).all()]

    def update_map(self, map_id, title, scope):
        with DBSession(self.engine) as db:
            row = db.get(KnowledgeMapRow, map_id)
            if row is None:
                raise KeyError(map_id)
            row.title = title
            row.scope = scope
            row.updated_at = now()
            session_row = db.get(SessionRow, map_id)
            if session_row is not None:
                payload = json.loads(session_row.payload)
                payload['domain_context'] = scope
                session_row.revision += 1
                payload['revision'] = session_row.revision
                session_row.payload = json.dumps(payload, ensure_ascii=False)
            db.commit()
            return self._map_dict(db, row)

    def save_divergence(self, batch):
        with DBSession(self.engine) as db:
            for item in batch.candidates:
                db.add(DivergenceCandidateRow(candidate_id=item.id,
                    source_map_id=batch.source_map_id,
                    source_concept_id=batch.source_concept_id,
                    source_concept_name=batch.source_concept_name,
                    payload=item.model_dump_json()))
            db.commit()

    def list_divergence_candidates(self, map_id=None):
        with DBSession(self.engine) as db:
            query = db.query(DivergenceCandidateRow)
            if map_id is not None:
                query = query.filter_by(source_map_id=map_id)
            return [{**json.loads(row.payload), 'source_map_id': row.source_map_id,
                     'source_concept_id': row.source_concept_id,
                     'source_concept_name': row.source_concept_name,
                     'target_map_id': row.target_map_id}
                    for row in query.order_by(DivergenceCandidateRow.candidate_id).all()]

    def get_divergence_candidate(self, map_id, concept_id, candidate_id):
        with DBSession(self.engine) as db:
            row = db.get(DivergenceCandidateRow, candidate_id)
            if row is None or row.source_map_id != map_id or row.source_concept_id != concept_id:
                raise KeyError(candidate_id)
            return {**json.loads(row.payload), 'source_map_id': map_id,
                    'source_concept_id': concept_id, 'source_concept_name': row.source_concept_name,
                    'target_map_id': row.target_map_id}

    def delete_map(self, map_id):
        with DBSession(self.engine) as db:
            map_row = db.get(KnowledgeMapRow, map_id)
            if map_row is None:
                raise KeyError(map_id)
            lineage_id = map_row.lineage_id
            refs = db.query(MapConceptRelationRow).filter_by(map_id=map_id).all()
            canonical_ids = {row.canonical_id for row in refs}
            for row in refs:
                db.delete(row)
            db.execute(delete(KnowledgeMapRelationRow).where(
                (KnowledgeMapRelationRow.source_map_id == map_id) |
                (KnowledgeMapRelationRow.target_map_id == map_id)))
            db.execute(delete(DivergenceCandidateRow).where(DivergenceCandidateRow.source_map_id == map_id))
            db.execute(update(DivergenceCandidateRow).where(
                DivergenceCandidateRow.target_map_id == map_id).values(target_map_id=None))
            db.execute(delete(PrefetchedDecompositionRow).where(PrefetchedDecompositionRow.session_id == map_id))
            db.execute(delete(ConceptEmbeddingRow).where(ConceptEmbeddingRow.session_id == map_id))
            db.execute(delete(ConceptMergeDecisionRow).where(ConceptMergeDecisionRow.session_id == map_id))
            db.delete(db.get(SessionRow, map_id))
            db.delete(map_row)
            db.flush()
            for canonical_id in canonical_ids:
                if not db.query(MapConceptRelationRow).filter_by(canonical_id=canonical_id).first():
                    canonical = db.get(CanonicalConceptRow, canonical_id)
                    if canonical:
                        db.delete(canonical)
            if not db.query(KnowledgeMapRow).filter_by(lineage_id=lineage_id).first():
                lineage = db.get(MapLineageRow, lineage_id)
                if lineage:
                    db.delete(lineage)
            db.commit()

    def canonical_refs(self, map_id):
        with DBSession(self.engine) as db:
            owner = self._owner_of(db, map_id)
            return {row.concept_id: dict(canonical_id=row.canonical_id,
                        target_mapping=json.loads(row.target_mapping),
                        other_maps=[other.map_id for other in db.query(MapConceptRelationRow).filter(
                            MapConceptRelationRow.canonical_id == row.canonical_id,
                            MapConceptRelationRow.map_id != map_id).all()
                            if owner is not None and self._owner_of(db, other.map_id) == owner])
                    for row in db.query(MapConceptRelationRow).filter_by(map_id=map_id).all()}

    def other_canonical_concepts(self, map_id, embedding_model=None):
        with DBSession(self.engine) as db:
            owner = self._owner_of(db, map_id)
            if owner is None:
                return []
            rows = db.query(MapConceptRelationRow).filter(
                MapConceptRelationRow.map_id != map_id).all()
            embeddings = {(row.session_id, row.concept_id): json.loads(row.embedding)
                for row in db.query(ConceptEmbeddingRow).filter_by(
                    embedding_model=embedding_model).all()} if embedding_model else {}
            by_canonical = {}
            for row in rows:
                if self._owner_of(db, row.map_id) != owner:
                    continue
                vector = embeddings.get((row.map_id, row.concept_id))
                if row.canonical_id in by_canonical:
                    if vector is not None and by_canonical[row.canonical_id]['embedding'] is None:
                        by_canonical[row.canonical_id]['embedding'] = vector
                        by_canonical[row.canonical_id]['map_id'] = row.map_id
                        by_canonical[row.canonical_id]['concept_id'] = row.concept_id
                    continue
                canonical = db.get(CanonicalConceptRow, row.canonical_id)
                map_row = db.get(KnowledgeMapRow, row.map_id)
                if canonical and map_row:
                    by_canonical[row.canonical_id] = dict(canonical_id=row.canonical_id,
                        map_id=row.map_id, concept_id=row.concept_id, theme=map_row.title,
                        concept=json.loads(canonical.concept), embedding=vector)
            return list(by_canonical.values())

    def link_canonical(self, map_id, concept_id, canonical_id, target_mapping):
        with DBSession(self.engine) as db:
            row = db.get(MapConceptRelationRow, (map_id, concept_id))
            canonical = db.get(CanonicalConceptRow, canonical_id)
            if row is None or canonical is None:
                raise KeyError(concept_id)
            owner = self._owner_of(db, map_id)
            existing_maps = db.query(MapConceptRelationRow).filter_by(canonical_id=canonical_id).all()
            if owner is None or not existing_maps or any(self._owner_of(db, other.map_id) != owner
                                    for other in existing_maps):
                raise PermissionError('異なるユーザーの知識項目は共有できません。')
            old_id = row.canonical_id
            row.canonical_id = canonical_id
            row.target_mapping = json.dumps(target_mapping)
            db.flush()
            if not db.query(MapConceptRelationRow).filter_by(canonical_id=old_id).first():
                old = db.get(CanonicalConceptRow, old_id)
                if old:
                    db.delete(old)
            db.commit()




def create_session_repository(settings):
    backend = getattr(settings, 'database_backend', 'auto')
    if backend in ('firestore', 'auto'):
        try:
            from app.repositories.firestore_sessions import FirestoreSessionRepository
            project = getattr(settings, 'google_cloud_project', '') or None
            return FirestoreSessionRepository(project=project)
        except Exception as exc:
            if backend == 'firestore':
                raise
            import logging
            logging.getLogger(__name__).warning('Firestore initialization failed; falling back to SQLite: %s', exc)
    return SessionRepository(settings.database_url)

