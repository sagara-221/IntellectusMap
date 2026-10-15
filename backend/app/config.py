# ==============================================================================
# アプリケーション設定モジュール (Settings)
# Pydantic Settingsを利用し、環境変数や.envファイルからの設定値読み込み・検証を行う
# ==============================================================================
import json
from pathlib import Path
from typing import Literal
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# プロジェクトルートディレクトリのパス
ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """アプリケーション全体の設定クラス。
    
    環境変数（.env または OS環境変数）から読み込みを行い、
    Gemini / Vertex AI、埋め込みベクトル、Firestore / SQLite、
    エージェント探索パラメーター等を一元管理する。
    """
    model_config = SettingsConfigDict(env_file=ROOT / '.env', env_file_encoding='utf-8', extra='ignore')

    # LLMバックエンド設定 (Google ADK)
    gemini_backend: str = 'adk'
    gemini_api_key: str = Field(default='', repr=False)
    judge_username: str = ''
    judge_password_hash: str = Field(default='', repr=False)
    judge_token_secret: str = Field(default='', repr=False)
    gemini_model: str = 'gemini-3.5-flash-lite'

    # GCPおよび認証関連設定
    gcp_config_dir: Path = ROOT / 'gcp_config'
    google_application_credentials: str = ''
    google_cloud_project: str = ''
    google_cloud_location: str = Field(default='global', pattern=r'^[a-z0-9-]+$')

    # LLM呼び出しタイムアウトおよび推論オプション
    llm_timeout_seconds: float = Field(default=40, gt=0)
    gemini_thinking_budget: int = Field(default=0, description='Gemini思考予算。3.5 Flash-Liteでは0でminimal、他のモデルでは0で思考OFF。-1でモデルデフォルト、正数で上限指定')

    # 先読み・同時実行パラメータ
    prefetch_ahead_layers: int = Field(default=1, ge=0, le=1)
    prefetch_concurrency: int = Field(default=20, ge=1, le=20)
    # チャット学習相談パラメータ
    chat_context_nodes: int = Field(default=12, ge=5, le=30)
    chat_retrieval_candidates: int = Field(default=12, ge=1, le=50)
    chat_retrieval_min_similarity: float = Field(default=.15, ge=-1, le=1)
    chat_routing_batch_size: int = Field(default=3, ge=1, le=10)
    chat_assessment_batch_size: int = Field(default=3, ge=1, le=10)
    chat_batch_overlap: float = Field(default=.5, ge=0, le=1)
    chat_history_messages: int = Field(default=16, ge=4, le=40)
    chat_history_chars: int = Field(default=200000, ge=100000, le=500000)
    chat_max_output_tokens: int = Field(default=700, ge=100, le=3000)
    chat_background_concurrency: int = Field(default=2, ge=1, le=5)
    chat_processing_concurrency: int = Field(default=20, ge=1, le=20)
    chat_chunk_chars: int = Field(default=4000, ge=1000, le=8000)
    chat_max_expansions: int = Field(default=10, ge=1, le=50)
    chat_max_additions: int = Field(default=10, ge=0, le=50)

    # 概念分解時のツリー生成数
    initial_max_children: int = Field(default=5, ge=3, le=10)
    expansion_max_children: int = Field(default=4, ge=2, le=10)

    # 発散マップ生成パラメータ
    divergence_candidate_count: int = Field(default=5, ge=1, le=15)
    divergence_max_candidate_count: int = Field(default=15, ge=1, le=15)

    # 埋め込みベクトル（Embedding）設定
    embedding_backend: Literal['auto', 'vertex', 'developer'] = 'auto'
    embedding_model: str = 'gemini-embedding-001'
    embedding_location: str = 'us-central1'
    embedding_timeout_seconds: float = Field(default=8, gt=0)

    # 概念マージ・類似度閾値
    concept_related_threshold: float = Field(default=.80, ge=0, le=1)
    concept_merge_candidate_threshold: float = Field(default=.93, ge=0, le=1)
    concept_strong_merge_threshold: float = Field(default=.96, ge=0, le=1)
    concept_merge_confidence_threshold: float = Field(default=.80, ge=0, le=1)
    concept_merge_top_k: int = Field(default=5, ge=1, le=20)

    # データベースバックエンド ('auto', 'firestore', 'sqlite')
    database_backend: Literal['auto', 'firestore', 'sqlite'] = 'auto'
    cross_map_missing_embed_limit: int = Field(default=10, ge=0, le=100)
    cross_map_concurrency: int = Field(default=2, ge=1, le=10)
    database_url: str = f'sqlite:///{ROOT / "diagnostic.db"}'

    # CORSフロントエンド許可オリジン
    frontend_origin: str = 'http://localhost:5173'

    @property
    def effective_divergence_candidate_count(self) -> int:
        """有効な発散マップ候補生成数を取得（上限値でキャップ）。"""
        return min(self.divergence_candidate_count, self.divergence_max_candidate_count)

    def vertex_configuration(self) -> tuple[Path | None, str]:
        """Vertex AI利用時の認証設定（認証ファイルパス、プロジェクトID）を解決・検証。
        
        Returns:
            tuple[Path | None, str]: (サービスアカウントJSONパス, プロジェクトID)
        Raises:
            ValueError: 認証ファイルが存在しないか、設定が不正な場合
        """
        if self.google_application_credentials:
            path = Path(self.google_application_credentials).expanduser()
            path = path if path.is_absolute() else ROOT / path
            if not path.exists():
                raise ValueError(f'指定された認証ファイルが存在しません: {path}')
        else:
            directory = self.gcp_config_dir
            directory = directory if directory.is_absolute() else ROOT / directory
            candidates = sorted(directory.glob('*.json')) if directory.exists() else []
            if len(candidates) == 1:
                path = candidates[0]
            elif len(candidates) > 1:
                raise ValueError('gcp_configにサービスアカウントJSONを1つ置くか、GOOGLE_APPLICATION_CREDENTIALSで使用するファイルを指定してください。')
            else:
                # candidates == 0: Cloud Run または ADC (Application Default Credentials) フォールバック
                import os, google.auth
                project = self.google_cloud_project or os.environ.get('GOOGLE_CLOUD_PROJECT', '') or os.environ.get('GCP_PROJECT', '')
                if not project:
                    try:
                        _, proj = google.auth.default()
                        project = proj or ''
                    except Exception:
                        pass
                if project:
                    return None, project
                raise ValueError('gcp_configにサービスアカウントJSONを1つ置くか、GOOGLE_APPLICATION_CREDENTIALSまたはGOOGLE_CLOUD_PROJECTを指定してください。')

        try:
            info = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            raise ValueError('サービスアカウントJSONを読み込めません。ファイルの配置と形式を確認してください。') from None
        if not isinstance(info, dict) or info.get('type') != 'service_account':
            raise ValueError('認証ファイルにはservice_account形式のJSONを指定してください。')
        if not all(info.get(key) for key in ('private_key', 'client_email', 'token_uri')):
            raise ValueError('サービスアカウントJSONの必須項目が不足しています。')
        if info['token_uri'] not in ('https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'):
            raise ValueError('サービスアカウントJSONの認証先がGoogleのOAuthエンドポイントではありません。')
        project = self.google_cloud_project or info.get('project_id', '')
        if not isinstance(project, str) or not project.strip():
            raise ValueError('GOOGLE_CLOUD_PROJECT、またはJSONのproject_idを指定してください。')
        return path, project

    @property
    def gemini_configuration_error(self) -> str | None:
        """ADKエージェントバックエンド設定の不備・エラーメッセージを返却（設定に問題なければNone）。"""
        if not self.gemini_model:
            return 'GEMINI_MODELを設定してください。'
        if self.gemini_backend == 'agent_platform':
            return None if self.gemini_api_key else 'GEMINI_API_KEYを設定してください。'
        try:
            self.vertex_configuration()
            return None
        except ValueError as exc:
            # GCP設定が未構成（キー0個・プロジェクト指定なし）の場合のみ、GEMINI_API_KEYでフォールバック可能
            if 'またはGOOGLE_CLOUD_PROJECTを指定してください' in str(exc) and self.gemini_api_key:
                return None
            return str(exc)

    @property
    def gemini_ready(self) -> bool:
        """ヘルスチェック用: Geminiバックエンドの設定が有効か判定（ネットワーク疎通は含まず）。"""
        return self.gemini_configuration_error is None

