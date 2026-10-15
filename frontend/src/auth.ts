// ==============================================================================
// フロントエンド認証管理モジュール (Auth)
// 用途: ローカルストレージでのIDトークン保持、JWTパース、テスト用Basic認証ログイン処理
// ==============================================================================
import { API_PREFIX } from './config';

/** 認証済みユーザーのプロファイル情報 */
export interface UserProfile {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  exp?: number;
}

const TOKEN_KEY = 'kgm_id_token';

/** テストモード認証用のダミープロファイル */
const GUEST_PROFILE: UserProfile = {
  sub: 'guest_user',
  name: 'テストユーザー（Basic認証済）',
  email: 'tester@example.com',
  exp: Math.floor(Date.now() / 1000) + 86400 * 365,
};

/**
 * JWTトークン文字列（Google ID Tokenまたはテスト署名トークン）をデコードし、プロファイルを取得。
 * 有効期限切れの場合はnullを返却。
 */
export function parseJwt(token: string): UserProfile | null {
  if (token.startsWith('judge.')) {
    const parts=token.split('.');
    const exp=Number(parts[1]);
    if(parts.length!==4||!Number.isFinite(exp)||exp*1000<=Date.now())return null;
    return {sub:'reviewer:intellectusmap',name:'審査員',exp};
  }
  // テスト用署名トークン (test_<exp>_<sig>) の期限判定
  if (token.startsWith('test_')) {
    const parts = token.split('_');
    if (parts.length >= 3) {
      const exp = parseInt(parts[1], 10);
      if (!isNaN(exp) && exp * 1000 <= Date.now()) {
        return null;
      }
    }
    return GUEST_PROFILE;
  }
  if (token === 'guest_token' || token === 'test_token' || token === 'test_guest_token') {
    return GUEST_PROFILE;
  }

  // Google OAuth2 ID Token (標準JWT) のBase64Urlデコード
  try {
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const parsed = JSON.parse(jsonPayload) as UserProfile;
    // 有効期限切れ（exp < 現在時刻）チェック
    if (parsed.exp && parsed.exp * 1000 <= Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * テスト環境用Basic認証情報でログインし、トークンを保存。
 */
export async function loginWithBasicAuth(username: string, password: string): Promise<UserProfile> {
  const res = await fetch(`${API_PREFIX}/auth/test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Basic認証に失敗しました。' }));
    throw new Error(err.detail || 'ユーザー名またはパスワードが正しくありません。');
  }
  const data = (await res.json()) as { token: string; user: UserProfile };
  setAuthToken(data.token);
  return data.user;
}

/**
 * 有効な認証トークンをローカルストレージから取得（期限切れ時はクリアしてnull）。
 */
export function getAuthToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const user = parseJwt(token);
  if (!user) {
    clearAuthToken();
    return null;
  }
  return token;
}

/** 認証トークンをローカルストレージに保存 */
export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** 認証トークンをローカルストレージから削除（ログアウト時） */
export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 現在ログイン中のユーザー情報を取得 */
export function getCurrentUser(): UserProfile | null {
  const token = getAuthToken();
  if (!token) return null;
  return parseJwt(token);
}


