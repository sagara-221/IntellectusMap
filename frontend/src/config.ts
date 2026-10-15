// ==============================================================================
// フロントエンド実行時設定 (Config)
// 用途: APIベースURLの切替。
//   - 本番(Firebase Hosting): VITE_API_BASE_URL に Cloud Run の URL を設定
//     (Hosting経由のrewriteは60秒でタイムアウトするため、長時間LLM処理は直接呼び出す)
//   - ローカル開発: 未設定 → 相対パス '/api' (Vite proxy)
// ==============================================================================
const base = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export const API_PREFIX = `${base}/api`;
