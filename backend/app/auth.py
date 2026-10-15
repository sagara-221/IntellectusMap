# ==============================================================================
# 認証・認可モジュール (Authentication & Authorization)
# 用途: Google OAuth2 ID Token検証、テスト環境用Basic認証および署名付きテストトークン処理
# ==============================================================================
import os
import json
import base64
import hmac
import hashlib
import time
import logging
from typing import Optional, Tuple
from fastapi import Header, HTTPException, status
from google.oauth2 import id_token
from google.auth.transport import requests

logger = logging.getLogger(__name__)

# Google OAuth2 Web Client ID (設定時はトークンのaudience検証に使用)
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '').strip() or None

# Basic認証用テストユーザー・パスワードおよびHMAC署名秘密鍵 (明示設定時のみ有効化)
TEST_USER = os.environ.get('TEST_USER', '').strip()
TEST_PASSWORD = os.environ.get('TEST_PASSWORD', '').strip()
TEST_SECRET = os.environ.get('TEST_SECRET', '').strip()
TEST_TOKEN_TTL_SECONDS = int(os.environ.get('TEST_TOKEN_TTL_SECONDS', '604800'))  # 7日間有効


def verify_test_credentials(username: Optional[str], password: Optional[str]) -> bool:
    """Basic認証のユーザー名・パスワードをタイミング攻撃耐性を持つ比較で照合。
    
    Args:
        username: 送信されたユーザー名
        password: 送信されたパスワード
    Returns:
        bool: 一致する場合True
    """
    if not TEST_USER or not TEST_PASSWORD:
        return False
    if not username or not password:
        return False
    user_ok = hmac.compare_digest(username.strip(), TEST_USER)
    pass_ok = hmac.compare_digest(password.strip(), TEST_PASSWORD)
    return user_ok and pass_ok


def generate_test_token() -> str:
    """検証済みのテストセッショントークンを発行。
    
    形式: test_<expires_at>_<hmac_sha256>
    Returns:
        str: 署名付きテストトークン
    """
    if not TEST_SECRET:
        raise HTTPException(status_code=503, detail='テスト認証機能は無効化されています。')
    expires_at = int(time.time()) + TEST_TOKEN_TTL_SECONDS
    msg = f"test_user:{expires_at}".encode('utf-8')
    sig = hmac.new(TEST_SECRET.encode('utf-8'), msg, hashlib.sha256).hexdigest()
    return f"test_{expires_at}_{sig}"


def verify_test_token(token: str) -> bool:
    """テストトークンのHMAC署名と有効期限を検証。
    
    Args:
        token: 検証対象のテストトークン文字列
    Returns:
        bool: 署名および期限が有効な場合True
    """
    if not TEST_SECRET:
        return False
    if not token or not token.startswith("test_"):
        return False
    parts = token.split("_")
    if len(parts) != 3:
        return False
    _, exp_str, sig = parts
    try:
        expires_at = int(exp_str)
    except ValueError:
        return False

    if time.time() > expires_at:
        logger.warning("Test token has expired: %s", expires_at)
        return False

    msg = f"test_user:{expires_at}".encode('utf-8')
    expected_sig = hmac.new(TEST_SECRET.encode('utf-8'), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected_sig)


def parse_basic_auth(auth_header: str) -> Optional[Tuple[str, str]]:
    """Authorization: Basic <base64> から (username, password) を抽出"""
    if not auth_header or not auth_header.startswith("Basic "):
        return None
    try:
        raw_b64 = auth_header.split("Basic ", 1)[1].strip()
        decoded = base64.b64decode(raw_b64).decode("utf-8")
        if ":" not in decoded:
            return None
        user, pwd = decoded.split(":", 1)
        return user, pwd
    except Exception:
        return None


def get_current_user(authorization: Optional[str] = Header(None), x_test_mode: Optional[str] = Header(None)) -> str:
    """FastAPI 依存関係: リクエストヘッダーから認証済みユーザー識別子を取得。
    
    1. pytestテスト実行時は 'test_user' を即時返却。
    2. Authorization: Basic の場合はテスト認証情報を照合し 'guest_user' を返却。
    3. Authorization: Bearer test_* の場合はHMAC署名付きテストトークンを検証し 'guest_user' を返却。
    4. それ以外の Bearer トークンの場合は Google OAuth2 ID Token として検証し GoogleユーザーID(sub) を返却。
    
    Args:
        authorization: Authorization HTTP ヘッダー値
        x_test_mode: テストモード制御用ヘッダー
    Returns:
        str: 認証済みユーザーの一意なID文字列
    Raises:
        HTTPException: 401 Unauthorized (認証情報不足、署名不一致、期限切れ)
    """
    # pytest 実行環境下ではテスト自動化のため test_user として動作
    if 'PYTEST_CURRENT_TEST' in os.environ and (not authorization or authorization in ('Bearer test_user', 'Bearer guest_token')):
        return 'test_user'

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='ログインが必要です。Googleアカウントまたはテスト認証情報で認証してください。',
            headers={'WWW-Authenticate': 'Bearer, Basic realm="KnowledgeGapMapper"'},
        )


    # 1. Basic認証 (Authorization: Basic base64(user:pass))
    if authorization.startswith("Basic "):
        creds = parse_basic_auth(authorization)
        if creds and verify_test_credentials(creds[0], creds[1]):
            return 'guest_user'
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Basic認証のユーザー名またはパスワードが無効です。',
            headers={'WWW-Authenticate': 'Basic realm="KnowledgeGapMapper"'},
        )

    # 2. Bearer認証 (Authorization: Bearer <token>)
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='認証ヘッダーの形式が正しくありません。',
            headers={'WWW-Authenticate': 'Bearer'},
        )

    token = authorization.split('Bearer ', 1)[1].strip()
    if token.startswith('judge.'):
        from app.judge_auth import verify, USER_ID
        if verify(token):
            return USER_ID
        raise HTTPException(401, '審査員ログインの有効期限が切れました。再ログインしてください。')
    if not token or token in ('null', 'undefined'):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='認証トークンが無効または未設定です。',
            headers={'WWW-Authenticate': 'Bearer'},
        )

    # テストトークン検証 (test_<exp>_<sig>)
    if token.startswith("test_"):
        if verify_test_token(token):
            return 'guest_user'
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='テストモード認証の有効期限が切れたか、トークンが無効です。Basic認証で再ログインしてください。',
            headers={'WWW-Authenticate': 'Basic realm="KnowledgeGapMapper"'},
        )

    # Google ID Token 検証 (Google公開鍵で署名・有効期限確認)
    try:
        request = requests.Request()
        id_info = id_token.verify_oauth2_token(token, request, GOOGLE_CLIENT_ID)
        user_id = id_info.get('sub')
        if not user_id:
            raise ValueError('Missing sub in token claims')
        logger.info('Authenticated user: %s (%s)', user_id, id_info.get('email', 'no-email'))
        return str(user_id)
    except Exception as exc:
        logger.warning('Authentication failed for token: %s', exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='認証の有効期限が切れたか、トークンが無効です。再ログインしてください。',
            headers={'WWW-Authenticate': 'Bearer'},
        ) from exc

