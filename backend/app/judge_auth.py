"""Opt-in reviewer login, isolated from Google and legacy guest accounts."""
import hashlib
import hmac
import secrets
import time
from fastapi import HTTPException
from app.config import Settings

USER_ID = 'reviewer:intellectusmap'
TTL = 86400


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 600_000).hex()
    return f'{salt}:{digest}'


def configured(settings):
    return bool(settings.judge_username and settings.judge_password_hash and len(settings.judge_token_secret) >= 32)


def login(username, password):
    settings = Settings()
    if not configured(settings):
        raise HTTPException(503, '審査員ログインはまだ設定されていません。管理者にご連絡ください。')
    salt = settings.judge_password_hash.split(':', 1)[0]
    valid_password = hmac.compare_digest(password_hash(password, salt), settings.judge_password_hash)
    valid_user = hmac.compare_digest(username.encode(), settings.judge_username.encode())
    if not (valid_password and valid_user):
        raise HTTPException(401, 'IDまたはパスワードが正しくありません。')
    exp = int(time.time()) + TTL
    nonce = secrets.token_hex(16)
    payload = f'judge.{exp}.{nonce}'
    sig = hmac.new(settings.judge_token_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return {'token': f'{payload}.{sig}', 'user': {'sub': USER_ID, 'name': '審査員', 'exp': exp}}


def verify(token):
    settings = Settings()
    if not configured(settings):
        return False
    try:
        prefix, expiry, nonce, signature = token.split('.')
        exp = int(expiry)
        if prefix != 'judge' or len(nonce) != 32 or not time.time() < exp <= time.time() + TTL + 60:
            return False
        expected = hmac.new(settings.judge_token_secret.encode(), f'{prefix}.{expiry}.{nonce}'.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected)
    except (ValueError, TypeError):
        return False
