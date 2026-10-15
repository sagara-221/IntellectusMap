# ==============================================================================
# フロントエンド単体配信用 Dockerfile (Nginx)
# 用途: フロントエンドをビルドし、軽量Nginxコンテナで静的配信およびAPIプロキシを行う
# ==============================================================================

# ビルドステージ: Node環境でTypeScript/Viteビルド
FROM node:24-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 実行ステージ: Nginxによる静的ファイルホスティング
FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

