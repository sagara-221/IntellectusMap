# ==============================================================================
# Vertex AI サービスアカウント認証ヘルパー
# 用途: サービスアカウントJSONまたはGCP ADC (Application Default Credentials) から
#       OAuth2アクセストークンを自動取得・更新する。
# ==============================================================================
import asyncio
import functools
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request
from google.oauth2 import service_account
from requests.exceptions import RequestException
from app.config import Settings
from app.llm.base import LLMError


class VertexAuth:
    """Vertex AI API呼び出し用認証管理クラス。
    
    スレッドセーフかつ非同期イベントループをブロックしないようトークン取得・更新を行う。
    """
    def __init__(self, settings: Settings):
        self.settings = settings
        self.credentials = None
        self.lock = asyncio.Lock()

    async def headers(self, force_refresh: bool = False) -> dict[str, str]:
        """Vertex AI呼び出しに必要なAuthorization Bearerヘッダーを返却。
        
        Args:
            force_refresh: キャッシュされたトークンの有効期限に関わらず強制再取得する場合True
        Returns:
            dict[str, str]: {'Authorization': 'Bearer <token>'}
        Raises:
            LLMError: 認証トークン取得失敗時
        """
        async with self.lock:
            try:
                # 資格情報オブジェクトの初期化
                if self.credentials is None:
                    path, _ = self.settings.vertex_configuration()
                    if path:
                        # ローカルJSONファイルから読み込み
                        self.credentials = service_account.Credentials.from_service_account_file(
                            str(path), scopes=['https://www.googleapis.com/auth/cloud-platform'])
                    else:
                        # Cloud RunメタデータサーバーまたはADC環境変数から読み込み
                        import google.auth
                        self.credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])

                # 有効期限切れまたは強制リフレッシュ時の再取得（同期HTTPを別スレッドで実行）
                if force_refresh or not self.credentials.valid:
                    request = functools.partial(Request(), timeout=self.settings.llm_timeout_seconds)
                    await asyncio.to_thread(self.credentials.refresh, request)

                return {'Authorization': f'Bearer {self.credentials.token}'}
            except (GoogleAuthError, RequestException, OSError, ValueError):
                # 認証情報の機密情報がログや例外詳細に漏洩しないよう共通メッセージでラップ
                raise LLMError('GCP認証に失敗しました。サービスアカウントJSONの有効性と通信状態を確認してください。') from None

