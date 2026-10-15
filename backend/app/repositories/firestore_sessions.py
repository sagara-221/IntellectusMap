# ==============================================================================
# Google Cloud Firestore セッションリポジトリ実装
# 用途: GCP Firestore (Nativeモード) を用いたセッション、アーティファクト、マップデータの永続化
# ==============================================================================
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Tuple, List
from google.cloud import firestore
import google.auth
from google.oauth2 import service_account

from app.models.domain import Decomposition, PreparedDecomposition, Session
from app.repositories.sessions import ConflictError

logger = logging.getLogger(__name__)


class FirestoreSessionRepository:
    def get_agent_runtime(self, session_id):
        snapshot = self.client.collection('agent_runtime').document(session_id).get()
        return snapshot.to_dict() if snapshot.exists else {'revision': 0, 'jobs': []}

    def mutate_agent_runtime(self, session_id, change):
        ref = self.client.collection('agent_runtime').document(session_id)
        @firestore.transactional
        def mutate(transaction):
            snapshot = ref.get(transaction=transaction)
            state = snapshot.to_dict() if snapshot.exists else {'revision': 0, 'jobs': []}
            change(state)
            state['revision'] += 1
            transaction.set(ref, state)
            return state
        return mutate(self.client.transaction())

    """Firestoreを用いたセッションおよび派生マップの永続化リポジトリ。
    
    コレクション構成:
    - sessions: 診断セッションメタデータおよびJSONペイロード
    - session_artifacts: 先読みキャッシュや埋め込みベクトル
    - knowledge_maps: マップメタデータ
    - map_lineages: マップ系譜
    - divergence_candidates: 発散テーマ候補
    """
    def __init__(self, project: Optional[str] = None, credentials_path: Optional[str] = None):
        self.project = project
        creds = None
        if credentials_path:
            try:
                creds = service_account.Credentials.from_service_account_file(credentials_path)
            except Exception as e:
                logger.warning('Failed to load service account file %s: %s', credentials_path, e)

        if creds is None:
            try:
                creds, default_proj = google.auth.default()
                if not self.project and default_proj:
                    self.project = default_proj
            except Exception as e:
                logger.warning('Failed to load default google credentials: %s', e)

        self.client = firestore.Client(project=self.project or None, credentials=creds)
        logger.info('Initialized FirestoreSessionRepository for project: %s', self.project)


    def _session_ref(self, session_id: str):
        return self.client.collection('sessions').document(session_id)

    def _artifacts_ref(self, session_id: str):
        return self.client.collection('session_artifacts').document(session_id)

    def get(self, session_id: str, user_id: Optional[str] = None) -> Session:
        doc = self._session_ref(session_id).get()
        if not doc.exists:
            raise KeyError(session_id)
        data = doc.to_dict()

        # ユーザーID認可チェック (指定がある場合のみ)
        doc_user = data.get('user_id', 'guest_user')
        if user_id is not None and doc_user != user_id:
            raise PermissionError(f'User {user_id} is not authorized to access session {session_id}')

        payload = json.loads(data['payload'])

        if not payload.get('complete') and 'review_min_depth' not in payload.get('config', {}):
            payload.setdefault('config', {}).update(max_total_questions=None, max_depth=None, review_min_depth=2)

        stack = [payload['knowledge_tree']]
        while stack:
            item = stack.pop()
            item.setdefault('terminal_confirmed', bool(item.get('terminal_reason') and not item.get('child_nodes')))
            stack.extend(item.get('child_nodes', []))

        session = Session.model_validate(payload)
        session.user_id = doc_user
        return session

    def list_sessions(self, user_id: str) -> List[dict]:
        try:
            docs = self.client.collection('sessions').where('user_id', '==', user_id).stream()
            results = []
            for doc in docs:
                d = doc.to_dict()
                theme = d.get('theme')
                complete = d.get('complete')
                questions_answered = d.get('questions_answered')
                if not theme and d.get('payload'):
                    try:
                        p = json.loads(d['payload'])
                        theme = p.get('theme', '無題の診断')
                        complete = p.get('complete', False)
                        questions_answered = len(p.get('evidence', []))
                    except Exception:
                        pass
                cost_data = d.get('cost_summary')
                if not cost_data and d.get('payload'):
                    try:
                        p = json.loads(d['payload'])
                        cost_data = p.get('cost_summary')
                    except Exception:
                        cost_data = None
                results.append({
                    'session_id': d.get('session_id'),
                    'theme': theme or '無題の診断',
                    'complete': bool(complete),
                    'questions_answered': questions_answered or 0,
                    'total_tokens': d.get('total_tokens') or (cost_data.get('total_tokens') if cost_data else 0),
                    'estimated_cost_jpy': d.get('estimated_cost_jpy') or (cost_data.get('estimated_cost_jpy') if cost_data else 0.0),
                    'cost_summary': cost_data,
                    'created_at': d.get('created_at', ''),
                    'updated_at': d.get('updated_at', ''),
                })
            results.sort(key=lambda x: x['created_at'], reverse=True)
            return results
        except Exception as e:
            logger.warning('Failed to list sessions for user %s: %s', user_id, e)
            return []

    def get_user_cost_summary(self, user_id: str) -> dict:
        sessions = self.list_sessions(user_id)
        total_tokens = sum(s.get('total_tokens', 0) for s in sessions)
        total_jpy = round(sum(s.get('estimated_cost_jpy', 0.0) for s in sessions), 4)
        return {
            'user_id': user_id,
            'session_count': len(sessions),
            'total_tokens': total_tokens,
            'total_estimated_cost_jpy': total_jpy,
            'sessions': sessions,
        }

    def create(self, session: Session, user_id: Optional[str] = None, origin: Optional[dict] = None, candidate_id: Optional[str] = None) -> None:
        user_id = user_id if user_id is not None else session.user_id
        session.user_id = user_id
        ref = self._session_ref(session.session_id)
        now_iso = datetime.now(timezone.utc).isoformat()
        payload = {
            'session_id': session.session_id,
            'user_id': user_id,
            'theme': session.theme,
            'complete': session.complete,
            'questions_answered': len(session.evidence),
            'total_tokens': session.cost_summary.total_tokens,
            'estimated_cost_jpy': session.cost_summary.estimated_cost_jpy,
            'cost_summary': session.cost_summary.model_dump(),
            'payload': session.model_dump_json(),
            'revision': 0,
            'created_at': now_iso,
            'updated_at': now_iso,
        }
        if origin is None and candidate_id is None:
            # A new independent map has a new lineage: no read is needed.
            # Persist all three documents in one round trip before opening chat.
            batch = self.client.batch()
            batch.set(ref, payload)
            batch.set(self._maps_ref().document(session.session_id), {
                'map_id': session.session_id, 'session_id': session.session_id,
                'lineage_id': session.session_id, 'title': session.theme,
                'scope': session.domain_context, 'created_at': now_iso,
                'updated_at': now_iso, 'origin': None,
            })
            batch.set(self._lineages_ref().document(session.session_id), {
                'lineage_id': session.session_id, 'root_map_id': session.session_id,
                'title': f"{session.theme}系統", 'map_ids': [session.session_id],
            })
            batch.commit()
            return
        ref.set(payload)
        # マップメタデータ登録
        try:
            lineage_id = session.session_id
            if origin:
                source_id = origin.get('source_map_id')
                if source_id:
                    source_doc = self._maps_ref().document(source_id).get()
                    if source_doc.exists:
                        lineage_id = source_doc.to_dict().get('lineage_id') or source_id
                    else:
                        lineage_id = source_id

            self._maps_ref().document(session.session_id).set({
                'map_id': session.session_id,
                'session_id': session.session_id,
                'lineage_id': lineage_id,
                'title': session.theme,
                'scope': session.domain_context,
                'created_at': now_iso,
                'updated_at': now_iso,
                'origin': origin,
            })
            if candidate_id:
                cand_ref = self._divergence_ref().document(candidate_id)
                cand_doc = cand_ref.get()
                if cand_doc.exists:
                    cand_ref.update({'target_map_id': session.session_id})

            if origin and origin.get('source_map_id'):
                rel_id = f"{origin['source_map_id']}_{session.session_id}"
                self._relations_ref().document(rel_id).set({
                    'source_map_id': origin['source_map_id'],
                    'source_concept_id': origin.get('source_concept_id'),
                    'target_map_id': session.session_id,
                    'category': origin.get('category'),
                    'relation': origin.get('relation'),
                    'reason': origin.get('reason'),
                    'created_at': now_iso,
                })

            # lineage ドキュメントの更新
            lineage_ref = self._lineages_ref().document(lineage_id)
            lineage_doc = lineage_ref.get()
            if lineage_doc.exists:
                cur_ids = lineage_doc.to_dict().get('map_ids', [])
                if session.session_id not in cur_ids:
                    cur_ids.append(session.session_id)
                    lineage_ref.update({'map_ids': cur_ids})
            else:
                self._lineages_ref().document(lineage_id).set({
                    'lineage_id': lineage_id,
                    'root_map_id': lineage_id,
                    'title': f"{session.theme}系統",
                    'map_ids': [lineage_id, session.session_id] if lineage_id != session.session_id else [session.session_id],
                })
        except Exception as e:
            logger.warning('Failed to register map in firestore: %s', e)

    def ensure_map(self, session_id: str) -> None:
        """Register one explicitly reused session if not already in maps collection."""
        try:
            map_ref = self._maps_ref().document(session_id)
            map_doc = map_ref.get()
            if map_doc.exists:
                return
            sess_doc = self._session_ref(session_id).get()
            if not sess_doc.exists:
                raise KeyError(session_id)
            d = sess_doc.to_dict()
            theme = d.get('theme') or '無題の診断'
            now_iso = datetime.now(timezone.utc).isoformat()
            map_ref.set({
                'map_id': session_id,
                'session_id': session_id,
                'lineage_id': session_id,
                'title': theme,
                'scope': None,
                'created_at': d.get('created_at') or now_iso,
                'updated_at': d.get('updated_at') or now_iso,
                'origin': None,
            })
            lineage_ref = self._lineages_ref().document(session_id)
            if not lineage_ref.get().exists:
                lineage_ref.set({
                    'lineage_id': session_id,
                    'root_map_id': session_id,
                    'title': f'{theme}系統',
                    'map_ids': [session_id],
                })
        except KeyError:
            raise
        except Exception as e:
            logger.warning('Failed to ensure map %s in firestore: %s', session_id, e)

    def _maps_ref(self):
        return self.client.collection('maps')

    def _lineages_ref(self):
        return self.client.collection('map_lineages')

    def _relations_ref(self):
        return self.client.collection('map_relations')

    def _divergence_ref(self):
        return self.client.collection('divergence_candidates')

    def list_maps(self) -> list[dict]:
        try:
            docs = list(self._maps_ref().stream())
            if not docs:
                sess_docs = self.client.collection('sessions').stream()
                results = []
                for s in sess_docs:
                    data = s.to_dict()
                    sid = data.get('session_id')
                    theme = data.get('theme') or '無題の診断'
                    results.append({
                        'map_id': sid,
                        'session_id': sid,
                        'lineage_id': sid,
                        'title': theme,
                        'scope': None,
                        'created_at': data.get('created_at'),
                        'updated_at': data.get('updated_at'),
                        'origin': None,
                    })
                return results
            return [doc.to_dict() for doc in docs]
        except Exception as e:
            logger.warning('Failed to list maps: %s', e)
            return []

    def get_map(self, map_id: str) -> dict:
        doc = self._maps_ref().document(map_id).get()
        if doc.exists:
            return doc.to_dict()
        sess_doc = self._session_ref(map_id).get()
        if not sess_doc.exists:
            raise KeyError(map_id)
        d = sess_doc.to_dict()
        return {
            'map_id': map_id,
            'session_id': map_id,
            'lineage_id': map_id,
            'title': d.get('theme', '無題の診断'),
            'scope': None,
            'created_at': d.get('created_at'),
            'updated_at': d.get('updated_at'),
            'origin': None,
        }

    def list_lineages(self) -> list[dict]:
        try:
            docs = list(self._lineages_ref().stream())
            if not docs:
                maps = self.list_maps()
                return [{
                    'lineage_id': m['map_id'],
                    'root_map_id': m['map_id'],
                    'title': m['title'],
                    'map_ids': [m['map_id']],
                } for m in maps]
            return [doc.to_dict() for doc in docs]
        except Exception as e:
            logger.warning('Failed to list lineages: %s', e)
            return []

    def list_map_relations(self) -> list[dict]:
        try:
            return [doc.to_dict() for doc in self._relations_ref().stream()]
        except Exception as e:
            logger.warning('Failed to list map relations: %s', e)
            return []

    def update_map(self, map_id: str, title: str, scope: Optional[str]) -> dict:
        m_ref = self._maps_ref().document(map_id)
        now_iso = datetime.now(timezone.utc).isoformat()
        m_doc = m_ref.get()
        if m_doc.exists:
            m_ref.update({'title': title, 'scope': scope, 'updated_at': now_iso})
            res = m_ref.get().to_dict()
        else:
            res = {
                'map_id': map_id,
                'session_id': map_id,
                'lineage_id': map_id,
                'title': title,
                'scope': scope,
                'created_at': now_iso,
                'updated_at': now_iso,
                'origin': None,
            }
            m_ref.set(res)
        sess = self.get(map_id)
        sess.domain_context = scope
        self.save(sess)
        return res

    def save_divergence(self, batch) -> None:
        b = self.client.batch()
        for item in batch.candidates:
            d_ref = self._divergence_ref().document(item.id)
            data = item.model_dump()
            data['source_map_id'] = batch.source_map_id
            data['source_concept_id'] = batch.source_concept_id
            data['source_concept_name'] = batch.source_concept_name
            data['target_map_id'] = None
            b.set(d_ref, data)
        b.commit()

    def list_divergence_candidates(self, map_id: Optional[str] = None) -> list[dict]:
        try:
            ref = self._divergence_ref()
            if map_id:
                query = ref.where('source_map_id', '==', map_id)
                docs = query.stream()
            else:
                docs = ref.stream()
            return [doc.to_dict() for doc in docs]
        except Exception as e:
            logger.warning('Failed to list divergence candidates from Firestore: %s', e)
            return []

    def get_divergence_candidate(self, map_id: str, concept_id: str, candidate_id: str) -> dict:
        doc = self._divergence_ref().document(candidate_id).get()
        if not doc.exists:
            raise KeyError(candidate_id)
        data = doc.to_dict()
        if data.get('source_map_id') != map_id or data.get('source_concept_id') != concept_id:
            raise KeyError(candidate_id)
        return data

    def delete_map(self, map_id: str) -> None:
        try:
            self._maps_ref().document(map_id).delete()
            self._session_ref(map_id).delete()
            self.delete_concept_artifacts(map_id, [])
            for doc in self._relations_ref().where('source_map_id', '==', map_id).stream():
                doc.reference.delete()
            for doc in self._relations_ref().where('target_map_id', '==', map_id).stream():
                doc.reference.delete()
            for doc in self._lineages_ref().stream():
                data = doc.to_dict()
                map_ids = data.get('map_ids', [])
                if map_id in map_ids:
                    new_ids = [m for m in map_ids if m != map_id]
                    if new_ids:
                        doc.reference.update({'map_ids': new_ids})
                    else:
                        doc.reference.delete()
        except Exception as e:
            logger.warning('Failed to delete map %s: %s', map_id, e)

    def canonical_refs(self, map_id: str) -> dict:
        return {}

    def other_canonical_concepts(self, map_id: str, embedding_model=None) -> list:
        return []

    def link_canonical(self, map_id: str, concept_id: str, canonical_id: str, target_mapping: dict) -> None:
        pass

    def save(self, session: Session, user_id: Optional[str] = None) -> None:
        old_rev = session.revision
        session.revision += 1
        effective_user = user_id or getattr(session, 'user_id', 'guest_user')
        session.user_id = effective_user
        ref = self._session_ref(session.session_id)

        @firestore.transactional
        def update_in_transaction(transaction):
            snapshot = ref.get(transaction=transaction)
            if not snapshot.exists:
                raise KeyError(session.session_id)
            cur_data = snapshot.to_dict()
            if cur_data.get('revision', 0) != old_rev:
                session.revision = old_rev
                raise ConflictError('セッションが更新されました。再読み込みしてください。')
            transaction.update(ref, {
                'payload': session.model_dump_json(),
                'revision': session.revision,
                'user_id': effective_user,
                'theme': session.theme,
                'complete': session.complete,
                'questions_answered': len(session.evidence),
                'total_tokens': session.cost_summary.total_tokens,
                'estimated_cost_jpy': session.cost_summary.estimated_cost_jpy,
                'cost_summary': session.cost_summary.model_dump(),
                'updated_at': datetime.now(timezone.utc).isoformat(),
            })

        transaction = self.client.transaction()
        update_in_transaction(transaction)

    def get_prefetch(self, session_id: str, concept_id: str) -> Tuple[Optional[str], Optional[PreparedDecomposition]]:
        doc = (self._artifacts_ref(session_id)
               .collection('prefetched_decompositions')
               .document(concept_id)
               .get())
        if not doc.exists:
            return None, None
        data = doc.to_dict()
        status = data.get('status')
        if status != 'ready':
            return status, None
        payload_str = data.get('payload')
        if not payload_str:
            return status, None
        try:
            try:
                return status, PreparedDecomposition.model_validate_json(payload_str)
            except ValueError:
                return status, PreparedDecomposition(decomposition=Decomposition.model_validate_json(payload_str))
        except ValueError:
            return None, None

    def prefetch_statuses(self, session_id: str) -> dict[str, str]:
        docs = (self._artifacts_ref(session_id)
                .collection('prefetched_decompositions')
                .stream())
        return {doc.id: doc.to_dict().get('status', '') for doc in docs}

    def ready_prefetch_payloads(self, session_id: str) -> dict[str, str]:
        docs = (self._artifacts_ref(session_id)
                .collection('prefetched_decompositions')
                .where('status', '==', 'ready')
                .stream())
        return {doc.id: doc.to_dict().get('payload') for doc in docs if doc.to_dict().get('payload') is not None}

    def save_prefetch(self, session_id: str, concept_id: str, result: Optional[PreparedDecomposition]) -> None:
        ref = (self._artifacts_ref(session_id)
               .collection('prefetched_decompositions')
               .document(concept_id))
        ref.set({
            'status': 'ready' if result is not None else 'failed',
            'payload': result.model_dump_json() if result is not None else None,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        })

    def get_merge_decision(self, session_id: str, cache_key: str) -> Optional[dict]:
        doc = (self._artifacts_ref(session_id)
               .collection('concept_merges')
               .document(cache_key)
               .get())
        if not doc.exists:
            return None
        return doc.to_dict().get('payload')

    def save_merge_decision(self, session_id: str, cache_key: str, payload: dict) -> None:
        ref = (self._artifacts_ref(session_id)
               .collection('concept_merges')
               .document(cache_key))
        ref.set({
            'cache_key': cache_key,
            'payload': payload,
            'created_at': datetime.now(timezone.utc).isoformat(),
        })

    def get_embedding(self, session_id: str, concept_id: str, model: str, content_hash: str) -> Optional[list[float]]:
        doc = (self._artifacts_ref(session_id)
               .collection('concept_embeddings')
               .document(concept_id)
               .get())
        if not doc.exists:
            return None
        data = doc.to_dict()
        if data.get('embedding_model') == model and data.get('embedding_text_hash') == content_hash:
            return data.get('vector')
        return None

    def save_embedding(self, session_id: str, concept_id: str, model: str, content_hash: str, vector: list[float]) -> None:
        ref = (self._artifacts_ref(session_id)
               .collection('concept_embeddings')
               .document(concept_id))
        ref.set({
            'concept_id': concept_id,
            'embedding_model': model,
            'embedding_text_hash': content_hash,
            'vector': vector,
            'created_at': datetime.now(timezone.utc).isoformat(),
        })

    def delete_prefetch(self, session_id: str, concept_id: str) -> None:
        (self._artifacts_ref(session_id)
         .collection('prefetched_decompositions')
         .document(concept_id)
         .delete())

    def delete_concept_artifacts(self, session_id: str, concept_ids: list[str]) -> None:
        if not concept_ids:
            return
        art_ref = self._artifacts_ref(session_id)
        batch = self.client.batch()
        for cid in concept_ids:
            p_ref = art_ref.collection('prefetched_decompositions').document(cid)
            e_ref = art_ref.collection('concept_embeddings').document(cid)
            batch.delete(p_ref)
            batch.delete(e_ref)
        batch.commit()
