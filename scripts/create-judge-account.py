"""Provision a local reviewer account. Credentials stay in ignored scratch/."""
from pathlib import Path
import secrets
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'backend'))
from app.judge_auth import password_hash

env = root / '.env'
text = env.read_text(encoding='utf-8-sig') if env.exists() else ''
if any(line.startswith('JUDGE_') and line.partition('=')[2].strip() for line in text.splitlines()):
    raise SystemExit('Judge settings already exist; no credentials were changed.')
text = '\n'.join(line for line in text.splitlines() if not line.startswith('JUDGE_'))
directory = root / 'scratch' / 'judge-account'
directory.mkdir(parents=True, exist_ok=True)
username = 'intellectus-judge'
password = secrets.token_urlsafe(18)
hashed = password_hash(password)
secret = secrets.token_urlsafe(48)
env.write_text(text.rstrip()+f'\n\nJUDGE_USERNAME={username}\nJUDGE_PASSWORD_HASH={hashed}\nJUDGE_TOKEN_SECRET={secret}\n', encoding='utf-8')
(directory / 'password-hash.txt').write_text(hashed, encoding='utf-8')
(directory / 'token-secret.txt').write_text(secret, encoding='utf-8')
import os
hosting_url = os.environ.get('APP_URL', 'https://<your-hosting-domain>.web.app')
(directory / 'login-details.txt').write_text(
    '審査員用アカウント（提出先以外には共有しないでください）\n'
    f'ID: {username}\nパスワード: {password}\n\n'
    '動作確認の方法（本番への設定・デプロイ後に提出してください）\n'
    f'1. {hosting_url} を開きます。\n'
    '2. 「審査員ログイン」に上記ID・パスワードを入力します。Googleログイン・メール受信は不要です。\n'
    '3. テーマ例「微分」、メモ例「高校数学の接線と導関数」を入力して探索を開始します。\n'
    '4. 探索受付で経験や疑問を送信し、生成されたノードを選びます。\n'
    '5. 調査手帳で自己評価または問題回答を行い、下位項目を展開します。\n'
    '6. 深堀マップ一覧・繋がりMAP一覧から保存済みの地図も確認できます。\n'
    '審査員アカウント内の履歴は共有されます。各審査員は新しい探索を作成してください。\n'
    'ローカル設定は作成済み。本番は別途設定が必要です。\n', encoding='utf-8')
print('Local account configured. Private submission details: scratch/judge-account/login-details.txt')
