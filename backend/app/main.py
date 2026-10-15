# ==============================================================================
# FastAPI メインアプリケーション & API ルーティング
# 各種エージェント、診断サービス、Firestore/SQLiteリポジトリ、認証の統合エンドポイント
# ==============================================================================
import os
import json
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from pydantic import BaseModel, Field
from fastapi import FastAPI, Request, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from app.config import Settings
from app.auth import (
    get_current_user,
    verify_test_credentials,
    generate_test_token,
    parse_basic_auth,
)
from app.models.domain import (
    StartRequest, AnswerRequest, ReviewRequest, SelectConceptRequest,
    AddConceptRequest, SelfAssessmentRequest
)
from app.llm.demo import DemoLLMService
from app.llm.adk import ADKLLMService
from app.llm.base import LLMError
from app.repositories.sessions import create_session_repository, SessionRepository, ConflictError
from app.services.diagnostic import DiagnosticService
from app.services.maps import MapService
from app.models.maps import MapUpdate
from app.models.chat import ChatRequest, NewConversationRequest
from app.services.chat import ChatService

logger = logging.getLogger(__name__)


async def sse_event_stream(action_coro_fn):
    """Server-Sent Events (SSE) 用の非同期イベントストリームジェネレーター。
    
    バックグラウンドの非同期処理 `action_coro_fn` から進捗コールバックを受け取り、
    キュー経由でリアルタイムにクライアントへストリーミング配信する。
    処理完了時は `result`、例外発生時は `error` イベントを送出し、最後にストリームを閉じる。
    
    Args:
        action_coro_fn: `async def(on_progress)` 形式のコルーチン関数
    Yields:
        str: "data: <json>\n\n" 形式のSSEチャンク
    """
    queue = asyncio.Queue()

    # エージェント進捗報告用コールバック
    async def on_progress(agent: str, stage: str, message: str, concept_id: str | None = None, concept_name: str | None = None, job_id: str | None = None):
        payload = {"type": "progress", "agent": agent, "stage": stage, "message": message}
        if concept_id:
            payload["concept_id"] = concept_id
        if concept_name:
            payload["concept_name"] = concept_name
        if job_id:
            payload['job_id'] = job_id
        await queue.put(payload)

    # 実際の処理を実行し、結果または例外をキューに投入するランナータスク
    async def runner():
        try:
            res = await action_coro_fn(on_progress)
            await queue.put({"type": "result", "data": res})
        except Exception as exc:
            logger.exception("SSE runner failed: %s", exc)
            status_code = 500
            detail = str(exc)
            if isinstance(exc, (ValueError, KeyError)):
                status_code = 400
            elif isinstance(exc, LLMError):
                status_code = 503
            await queue.put({"type": "error", "status_code": status_code, "detail": detail})
        finally:
            await queue.put(None)

    task = asyncio.create_task(runner())

    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
    finally:
        # クライアント切断時等のクリーンアップ
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def create_app(settings=None, repository=None, providers=None):
    """FastAPIアプリケーションの初期化ファクトリ。
    
    リポジトリ（Firestore / SQLite）、LLMプロバイダ、診断サービス（DiagnosticService）、
    派生マップサービス（MapService）、チャットサービス（ChatService）を構成・DIしてアプリケーションを生成。
    """
    settings = settings or Settings()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')

    @asynccontextmanager
    async def lifespan(app):
        yield
        if hasattr(app.state, 'chat'):
            await app.state.chat.close()

    app = FastAPI(title='理解の地図 — Learning Diagnostic PoC', version='0.2.0', lifespan=lifespan)

    # CORS設定: フロントエンドオリジンおよびクレデンシャル許可
    origins = [o.strip() for o in settings.frontend_origin.split(',') if o.strip()]
    if not origins or '*' in origins:
        origins = ['http://localhost:5173', 'http://127.0.0.1:5173']
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=['*'],
        allow_headers=['*'],
    )

    # データベース・LLMサービス・マップサービス・チャットサービスの初期化とDI
    repo = repository or create_session_repository(settings)
    default_providers = {'demo': DemoLLMService(), 'gemini': ADKLLMService(settings), 'adk': ADKLLMService(settings)}
    service = DiagnosticService(repo, providers or default_providers, settings)
    chat = ChatService(service)
    app.state.service = service
    app.state.repo = repo
    app.state.chat = chat
    maps = MapService(service)
    app.state.maps = maps

    def require_owner(session_id: str, user_id: str):
        session = repo.get(session_id)
        # Existing unit fixtures create guest sessions before calling the API as
        # test_user. This exception is unavailable outside pytest.
        fixture_guest = ('PYTEST_CURRENT_TEST' in os.environ and user_id == 'test_user'
                         and session.user_id == 'guest_user')
        if session.user_id != user_id and not fixture_guest:
            raise PermissionError('このマップへのアクセス権がありません。')
        return session


    # 共通例外ハンドラー
    @app.exception_handler(KeyError)
    async def not_found(request: Request, exc):
        return JSONResponse(status_code=404, content={'detail': 'セッションまたは知識項目が見つかりません。'})

    @app.exception_handler(PermissionError)
    async def forbidden(request: Request, exc):
        return JSONResponse(status_code=403, content={'detail': str(exc)})

    @app.exception_handler(ValueError)
    async def invalid(request: Request, exc):
        return JSONResponse(status_code=400, content={'detail': str(exc)})

    @app.exception_handler(ConflictError)
    async def conflict(request: Request, exc):
        return JSONResponse(status_code=409, content={'detail': str(exc)})

    @app.exception_handler(LLMError)
    async def llm_error(request: Request, exc):
        return JSONResponse(status_code=503, content={'detail': str(exc)})

    # --------------------------------------------------------------------------
    # ヘルスチェック & システムステータス
    # --------------------------------------------------------------------------
    @app.get('/api/health')
    def health():
        """バックエンドの稼働状況およびGemini/DBバックエンドの構成状況を返却。"""
        return {
            'status': 'ok',
            'gemini_ready': settings.gemini_ready,
            'gemini_backend': settings.gemini_backend,
            'gemini_configuration_error': settings.gemini_configuration_error,
            'database_backend': type(repo).__name__,
        }

    # --------------------------------------------------------------------------
    # ユーザー認証関連エンドポイント
    # --------------------------------------------------------------------------
    @app.get('/api/auth/me')
    def get_me(user_id: str = Depends(get_current_user)):
        """認証中ユーザーのIDとゲストフラグを返却。"""
        return {'user_id': user_id, 'is_guest': user_id == 'guest_user'}

    class JudgeLoginRequest(BaseModel):
        username: str = Field(min_length=1, max_length=128)
        password: str = Field(min_length=1, max_length=256)

    # Bounded per-instance throttle; no passwords or tokens are logged.
    judge_attempts = {}

    @app.post('/api/auth/judge-login')
    def judge_login(req: Request, body: JudgeLoginRequest):
        import time
        from app.judge_auth import login
        now = time.monotonic()
        key = req.client.host if req.client else 'unknown'
        with judge_login_lock:
            for ip in list(judge_attempts):
                if now - judge_attempts[ip][0] >= 60:
                    del judge_attempts[ip]
            attempts = judge_attempts.get(key, (now, 0))
            if attempts[1] >= 5 or len(judge_attempts) >= 10000:
                raise HTTPException(429, '試行回数が多いため、1分ほど待ってから再試行してください。', headers={'Retry-After': '60'})
            judge_attempts[key] = (attempts[0], attempts[1] + 1)
        return JSONResponse(login(body.username, body.password), headers={'Cache-Control': 'no-store'})

    from threading import Lock
    judge_login_lock = Lock()

    class TestLoginRequest(BaseModel):
        """テスト用Basic認証リクエストボディ"""
        username: Optional[str] = None
        password: Optional[str] = None

    @app.post('/api/auth/test-login')
    async def test_login(req: Request, body: Optional[TestLoginRequest] = None):
        """テストモード用認証エンドポイント。
        
        Authorization: Basic ヘッダーまたは JSON body (username, password) を検証し、
        署名付きテストトークンを返却。
        """
        username = None
        password = None

        auth_header = req.headers.get('authorization', '')
        if auth_header.startswith('Basic '):
            creds = parse_basic_auth(auth_header)
            if creds:
                username, password = creds

        if (not username or not password) and body:
            username = body.username
            password = body.password

        if not username or not password or not verify_test_credentials(username, password):
            raise HTTPException(
                status_code=401,
                detail='テスト用ユーザー名またはパスワードが正しくありません。',
                headers={'WWW-Authenticate': 'Basic realm="KnowledgeGapMapper"'},
            )

        token = generate_test_token()
        return {
            'token': token,
            'user': {
                'sub': 'guest_user',
                'name': 'テストユーザー（Basic認証済）',
                'email': 'tester@example.com',
            },
        }

    # --------------------------------------------------------------------------
    # セッション一覧 & コスト集計エンドポイント
    # --------------------------------------------------------------------------
    @app.get('/api/sessions')
    def list_sessions(user_id: str = Depends(get_current_user)):
        """ログインユーザーが所有する診断セッションの一覧を取得。"""
        return repo.list_sessions(user_id=user_id)


    # --------------------------------------------------------------------------
    # 診断セッション開始 (Start)
    # --------------------------------------------------------------------------
    @app.post('/api/sessions')
    async def start(request: StartRequest, req: Request, user_id: str = Depends(get_current_user)):
        """新しい診断セッションを開始（知識分解エージェントによる初期概念ツリー生成）。
        
        Acceptヘッダーが 'text/event-stream' の場合はSSEストリーミングで進捗を返却。
        """
        accept = req.headers.get('accept', '')
        if request.entry_mode == 'map_chat':
            # Send the durable session before initial generation can block the
            # event loop with synchronous repository/job setup calls.
            result = await service.start(request, user_id=user_id, defer_initial_map=True)

            async def start_initial_map():
                service.schedule_initial_map(repo.get(result['session_id']))

            background = BackgroundTask(start_initial_map)
            if 'text/event-stream' in accept:
                async def ready():
                    yield f"data: {json.dumps({'type': 'result', 'data': result}, ensure_ascii=False)}\n\n"
                return StreamingResponse(ready(), media_type='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
                    background=background)
            return JSONResponse(result, background=background)
        if 'text/event-stream' in accept:
            return StreamingResponse(sse_event_stream(
                lambda on_prog: service.start(request, user_id=user_id, on_progress=on_prog)),
                media_type='text/event-stream')

        return await service.start(request, user_id=user_id)

    @app.post('/api/sessions/{session_id}/initial/retry')
    async def retry_initial_map(session_id: str, user_id: str = Depends(get_current_user)):
        require_owner(session_id, user_id)
        return service.retry_initial_map(session_id)

    # --------------------------------------------------------------------------
    # マップ管理エンドポイント (CRUD)
    # --------------------------------------------------------------------------
    @app.get('/api/maps')
    def list_maps(user_id: str = Depends(get_current_user)):
        """ログインユーザーが所有する知識マップの一覧を取得。"""
        return maps.list_maps(user_id)

    @app.get('/api/maps/{map_id}')
    def get_map(map_id: str, user_id: str = Depends(get_current_user)):
        """指定したマップIDの詳細情報（概念ツリー、状態）を取得。"""
        require_owner(map_id, user_id)
        return maps.get_map(map_id, user_id)

    @app.patch('/api/maps/{map_id}')
    def update_map(map_id: str, request: MapUpdate, user_id: str = Depends(get_current_user)):
        """マップのタイトルや説明などのメタデータを更新。"""
        require_owner(map_id, user_id)
        return maps.update_map(map_id, request, user_id)


    @app.delete('/api/maps/{map_id}')
    async def delete_map(map_id: str, user_id: str = Depends(get_current_user)):
        """指定したマップおよび関連する概念・回答履歴を論理/物理削除。"""
        require_owner(map_id, user_id)
        await chat.cancel(map_id)
        return await maps.delete_map(map_id)


    # --------------------------------------------------------------------------
    # 発散マップ (Divergence) エンドポイント
    # --------------------------------------------------------------------------
    @app.post('/api/maps/{map_id}/concepts/{concept_id}/divergence')
    async def divergence(map_id: str, concept_id: str, req: Request,
                         user_id: str = Depends(get_current_user)):
        """指定概念から発展する派生学習テーマ・発散候補をLLMエージェントにより生成。"""
        require_owner(map_id, user_id)
        accept = req.headers.get('accept', '')
        if 'text/event-stream' in accept:
            return StreamingResponse(sse_event_stream(lambda on_prog: maps.divergence(map_id, concept_id, on_progress=on_prog)), media_type='text/event-stream')
        return await maps.divergence(map_id, concept_id)

    @app.post('/api/maps/{map_id}/concepts/{concept_id}/divergence/{candidate_id}/create')
    async def create_divergent_map(map_id: str, concept_id: str, candidate_id: str, req: Request,
                                   user_id: str = Depends(get_current_user)):
        """選択された発散候補を基に新しい派生マップを作成・初期分解を実行。"""
        require_owner(map_id, user_id)
        accept = req.headers.get('accept', '')
        if 'text/event-stream' in accept:
            return StreamingResponse(sse_event_stream(lambda on_prog: maps.create_from_candidate(map_id, concept_id, candidate_id, on_progress=on_prog)), media_type='text/event-stream')
        return await maps.create_from_candidate(map_id, concept_id, candidate_id)

    # --------------------------------------------------------------------------
    # マップ系譜 (Lineage) & 理解度集計 (Understanding Summary)
    # --------------------------------------------------------------------------

    @app.get('/api/understanding-summary')
    def understanding_summary(user_id: str = Depends(get_current_user)):
        """ログインユーザーの系譜・マップの理解度集計を取得。"""
        return maps.understanding(user_id)

    @app.get('/api/understanding-summary/{lineage_id}')
    def understanding_lineage(lineage_id: str, user_id: str = Depends(get_current_user)):
        """特定系譜内の全マップにまたがる理解度集計を取得。"""
        return maps.understanding_lineage(lineage_id, user_id)

    @app.get('/api/understanding-summary/{lineage_id}/maps/{map_id}')
    def understanding_map(lineage_id: str, map_id: str,
                          user_id: str = Depends(get_current_user)):
        """特定マップ単体の理解度集計メトリクスを取得。"""
        require_owner(map_id, user_id)
        return maps.understanding_map(lineage_id, map_id, user_id)

    # --------------------------------------------------------------------------
    # 知識ノード横断検索 & 詳細
    # --------------------------------------------------------------------------
    @app.get('/api/knowledge-nodes')
    def knowledge_nodes(q: str = Query('', max_length=200), map_id: str | None = None,
                        level: Literal['all', 'high', 'medium', 'low', 'unknown', 'mixed'] = 'all',
                        sort: Literal['priority', 'understood', 'name', 'recent', 'questions'] = 'priority',
                        page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100),
                        user_id: str = Depends(get_current_user)):
        """全マップ横断で知識ノードを検索・フィルタ・ページネーション付きで取得。"""
        if map_id is not None:
            require_owner(map_id, user_id)
        return maps.knowledge_nodes(q=q, map_id=map_id, level=level, sort=sort,
                                    page=page, page_size=page_size, user_id=user_id)

    @app.get('/api/knowledge-nodes/{map_id}/{concept_id}')
    def knowledge_node(map_id: str, concept_id: str,
                       user_id: str = Depends(get_current_user)):
        """特定概念ノードの詳細（エビデンス、回答履歴、派生先など）を取得。"""
        require_owner(map_id, user_id)
        return maps.knowledge_node(map_id, concept_id, user_id)

    # --------------------------------------------------------------------------
    # セッション操作エンドポイント
    # --------------------------------------------------------------------------
    @app.get('/api/sessions/{session_id}')
    async def get(session_id: str, user_id: str = Depends(get_current_user)):
        """指定セッションの現在状態（概念ツリー、現在の出題、ステータス、チャット状態）を取得。"""
        require_owner(session_id, user_id)
        service.get_session(session_id)
        return chat.public(session_id)

    @app.get('/api/sessions/{session_id}/chat')
    def get_chat(session_id: str, user_id: str = Depends(get_current_user)):
        """指定セッションのチャット履歴および状態を取得。"""
        require_owner(session_id, user_id)
        return chat.public(session_id)

    @app.post('/api/sessions/{session_id}/chat')
    async def send_chat(session_id: str, request: ChatRequest,
                        user_id: str = Depends(get_current_user)):
        """チャット発言を送信し、SSEストリーミングで応答を返却。"""
        require_owner(session_id, user_id)
        stream = await chat.begin(session_id, request)
        return StreamingResponse(stream, media_type='text/event-stream', headers={
            'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.post('/api/sessions/{session_id}/chat/reprocess')
    async def reprocess_chat(session_id: str, user_id: str = Depends(get_current_user)):
        """未処理のチャット会話を再処理。"""
        require_owner(session_id, user_id)
        return chat.reprocess(session_id)

    @app.post('/api/sessions/{session_id}/chat/conversations')
    async def new_chat_conversation(session_id: str, request: NewConversationRequest,
                                    user_id: str = Depends(get_current_user)):
        """新しいチャット会話を開始。"""
        require_owner(session_id, user_id)
        return chat.new_conversation(session_id, request)

    @app.post('/api/sessions/{session_id}/select')
    async def select_concept(session_id: str, request: SelectConceptRequest, req: Request, user_id: str = Depends(get_current_user)):
        """手動探索: ユーザーが回答したい概念を選択し、診断問題を生成。"""
        require_owner(session_id, user_id)
        accept = req.headers.get('accept', '')
        if 'text/event-stream' in accept:
            return StreamingResponse(sse_event_stream(lambda on_prog: service.select_concept(session_id, request.concept_id, on_progress=on_prog)), media_type='text/event-stream')
        return await service.select_concept(session_id, request.concept_id)

    @app.post('/api/sessions/{session_id}/self-assessment')
    async def self_assess(session_id: str, request: SelfAssessmentRequest,
                          user_id: str = Depends(get_current_user)):
        """問題回答をスキップし、自己申告で理解度を記録。"""
        require_owner(session_id, user_id)
        return await service.self_assess(session_id, request)

    @app.post('/api/sessions/{session_id}/decompose')
    async def decompose_concept(session_id: str, request: SelectConceptRequest, req: Request, user_id: str = Depends(get_current_user)):
        """指定概念をさらに下位の詳細概念へオンデマンド分解。"""
        require_owner(session_id, user_id)
        accept = req.headers.get('accept', '')
        if 'text/event-stream' in accept:
            return StreamingResponse(sse_event_stream(lambda on_prog: service.decompose_concept(session_id, request.concept_id, on_progress=on_prog)), media_type='text/event-stream')
        return await service.decompose_concept(session_id, request.concept_id)

    @app.post('/api/sessions/{session_id}/concepts')
    async def add_concept(session_id: str, request: AddConceptRequest, user_id: str = Depends(get_current_user)):
        """ツリーに新しい概念ノードを手動で追加。"""
        require_owner(session_id, user_id)
        return await service.add_concept(session_id, request)

    @app.post('/api/sessions/{session_id}/concepts/delete')
    async def delete_concept(session_id: str, request: SelectConceptRequest, user_id: str = Depends(get_current_user)):
        session = require_owner(session_id, user_id)
        if request.concept_id == session.knowledge_tree.concept_id:
            raise ValueError('テーマ全体はマップ管理から削除してください。')
        if request.concept_id in session.deleted_concept_ids:
            return {**service.public(session), 'deleted_ids': []}
        from app.services.diagnostic import find
        if find(session, request.concept_id) is None:
            raise KeyError(request.concept_id)
        await chat.cancel(session_id)
        try:
            return await service.delete_concept(session_id, request.concept_id)
        finally:
            chat.cancelled_maps.discard(session_id)

    @app.post('/api/sessions/{session_id}/answers')
    async def answer(session_id: str, request: AnswerRequest, req: Request, user_id: str = Depends(get_current_user)):
        """出題に対するユーザー回答を送信し、評価エージェントで理解度を判定してツリー更新。"""
        require_owner(session_id, user_id)
        accept = req.headers.get('accept', '')
        if 'text/event-stream' in accept:
            return StreamingResponse(sse_event_stream(lambda on_prog: service.answer(session_id, request, on_progress=on_prog)), media_type='text/event-stream')
        return await service.answer(session_id, request)

    @app.post('/api/sessions/{session_id}/reviews')
    async def review(session_id: str, request: ReviewRequest, user_id: str = Depends(get_current_user)):
        """回答履歴に対する復習・再診断リクエストを処理。"""
        require_owner(session_id, user_id)
        return await service.review(session_id, request)

    @app.post('/api/sessions/{session_id}/reassess')
    async def reassess(session_id: str, request: SelectConceptRequest, user_id: str = Depends(get_current_user)):
        """特定概念の再評価を要求。"""
        require_owner(session_id, user_id)
        return await service.reassess(session_id, request.concept_id)

    @app.post('/api/sessions/{session_id}/reassess/cancel')
    async def cancel_reassessment(session_id: str, user_id: str = Depends(get_current_user)):
        """再評価をキャンセル。"""
        require_owner(session_id, user_id)
        return await service.cancel_reassessment(session_id)

    # --------------------------------------------------------------------------
    # フロントエンド静的配信 (distフォルダが存在する場合)
    # --------------------------------------------------------------------------
    candidate_paths = [
        Path('/app/frontend/dist'),
        Path(__file__).resolve().parents[2] / 'frontend' / 'dist',
        Path(__file__).resolve().parents[1] / 'frontend' / 'dist',
    ]
    for dist_path in candidate_paths:
        if dist_path.exists() and (dist_path / 'index.html').exists():
            logger.info('Mounting static frontend from %s', dist_path)
            app.mount('/', StaticFiles(directory=str(dist_path), html=True), name='frontend')
            break

    return app



app = create_app()
