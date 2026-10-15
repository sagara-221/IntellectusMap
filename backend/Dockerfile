# ==============================================================================
# バックエンド単体実行用 Dockerfile
# 用途: バックエンドのみをローカルまたは独立コンテナとして実行する場合のイメージビルド
# ==============================================================================
FROM python:3.12-slim
WORKDIR /app

# 依存定義（lockfile）のインストール
COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock

# アプリケーションコードの配置
COPY backend/app ./app

# ポート公開とAPIサーバー起動
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

