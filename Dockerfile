# ==============================================================================
# バックエンド専用 Dockerfile (Cloud Run / FastAPI)
# フロントエンドは Firebase Hosting から配信するため本イメージには含めない
# ==============================================================================
FROM python:3.12-slim
WORKDIR /app

# 実行時デフォルト環境変数
ENV PYTHONUNBUFFERED=1 \
    PORT=8080 \
    GEMINI_BACKEND=adk \
    GEMINI_MODEL=gemini-3.5-flash-lite \
    GEMINI_THINKING_BUDGET=0 \
    GOOGLE_CLOUD_PROJECT="" \
    GOOGLE_CLOUD_LOCATION=global \
    DATABASE_BACKEND=firestore

# バックエンド依存パッケージのインストール
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# バックエンドアプリケーションコードを配置
COPY backend/app ./app

# Cloud Run 標準ポートを公開し Uvicorn でサーバー起動
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
