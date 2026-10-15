import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ==============================================================================
// Vite 設定
// 用途: Reactプラグイン適用、ローカル開発サーバーでのバックエンドAPIプロキシ
// ==============================================================================
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: 'index.html', atlas: 'atlas.html', legacy: 'legacy.html' } },
  },
  server: {
    // ローカル開発時の/apiリクエストをFastAPIバックエンドへ中継
    proxy: {
      '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:8000',
    },
  },
});

