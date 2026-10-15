// ==============================================================================
// バックエンド API 通信クライアント (API Client)
// 用途: HTTPリクエスト発行、Bearer認証ヘッダー付加、401認可エラーハンドリング、SSEストリーム受信
// ==============================================================================
import { getAuthToken, clearAuthToken } from './auth';
import { API_PREFIX } from './config';

/**
 * 標準のJSON REST API呼び出し関数 (GET / POST)。
 * 
 * @param path APIエンドポイントパス (例: '/sessions')
 * @param body POSTリクエスト用ペイロード（未指定時はGET）
 */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 502/500などの非JSONレスポンスを許容
  }

  if (!response.ok) {
    const message = data && typeof data.detail === 'string'
      ? data.detail
      : (data && typeof data.message === 'string' ? data.message : `エラーが発生しました (${response.status})`);
    if (response.status === 401) {
      clearAuthToken();
      sessionStorage.removeItem('diagnostic-session');
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: { message } }));
    }
    throw new Error(message);
  }
  return data;
}

/**
 * PATCH / DELETE メソッド用API呼び出し関数。
 */
export async function apiMethod<T>(path: string, method: 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 非JSONレスポンス
  }
  if (!response.ok) {
    const message = data && typeof data.detail === 'string'
      ? data.detail
      : (data && typeof data.message === 'string' ? data.message : `処理に失敗しました (${response.status})`);
    if (response.status === 401) {
      clearAuthToken();
      sessionStorage.removeItem('diagnostic-session');
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: { message } }));
    }
    throw new Error(message);
  }
  return data;
}


export interface AgentProgress {
  job_id?: string;
  agent: string;
  stage: string;
  message: string;
  concept_id?: string | null;
  concept_name?: string | null;
}

export interface AgentVisualConfig {
  agentName: string;
  shortName: string;
  label: string;
  icon: string;
  color: string;
  glow: string;
  pulseColor: string;
}

export const AGENT_CONFIGS: Record<string, AgentVisualConfig> = {
  DecompositionAgent: {
    agentName: '分解係',
    shortName: '分解係',
    label: '概念ツリー分解中',
    icon: '⚡',
    color: '#6366f1',
    glow: 'rgba(99, 102, 241, 0.9)',
    pulseColor: 'rgba(99, 102, 241, 0.45)',
  },
  QuestionAgent: {
    agentName: '出題係',
    shortName: '出題係',
    label: '4択問題を作成中',
    icon: '🎯',
    color: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.9)',
    pulseColor: 'rgba(245, 158, 11, 0.45)',
  },
  EvaluationAgent: {
    agentName: '評価係',
    shortName: '評価係',
    label: '回答採点・ギャップ分析中',
    icon: '⚖️',
    color: '#10b981',
    glow: 'rgba(16, 185, 129, 0.9)',
    pulseColor: 'rgba(16, 185, 129, 0.45)',
  },
  DivergenceAgent: {
    agentName: '探索係',
    shortName: '探索係',
    label: '関連トピック探索中',
    icon: '🌱',
    color: '#a855f7',
    glow: 'rgba(168, 85, 247, 0.9)',
    pulseColor: 'rgba(168, 85, 247, 0.45)',
  },
  ConceptDeduplicator: {
    agentName: '統合係',
    shortName: '統合係',
    label: '重複知識を統合中',
    icon: '🔗',
    color: '#06b6d4',
    glow: 'rgba(6, 182, 212, 0.9)',
    pulseColor: 'rgba(6, 182, 212, 0.45)',
  },
  DiagnosticService: {
    agentName: '進行係',
    shortName: '進行係',
    label: '診断セッション準備中',
    icon: '🧭',
    color: '#ec4899',
    glow: 'rgba(236, 72, 153, 0.9)',
    pulseColor: 'rgba(236, 72, 153, 0.45)',
  },
};

export const DEFAULT_AGENT_CONFIG: AgentVisualConfig = {
  agentName: '作業係',
  shortName: '作業係',
  label: 'エージェント稼働中',
  icon: '🤖',
  color: '#6366f1',
  glow: 'rgba(99, 102, 241, 0.9)',
  pulseColor: 'rgba(99, 102, 241, 0.45)',
};

/**
 * Server-Sent Events (SSE) ストリーミング対応のAPI呼び出し関数。
 * 
 * 進行中のエージェント進捗報告（progressイベント）をリアルタイムにコールバックへ渡しつつ、
 * 最終結果（resultイベント）をPromiseとして解決する。
 * 
 * @param path APIエンドポイントパス
 * @param body リクエストボディ
 * @param onProgress 進捗更新時コールバック
 * @param method HTTPメソッド (デフォルト: POST)
 */
export async function apiStream<T>(
  path: string,
  body?: unknown,
  onProgress?: (progress: AgentProgress) => void,
  method?: string
): Promise<T> {
  const reqMethod = method || (body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {
    'Accept': 'text/event-stream, application/json',
  };
  if (reqMethod !== 'GET' && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    method: reqMethod,
    headers,
    body: (reqMethod === 'GET' || body === undefined) ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非JSONエラーレスポンス
    }
    const message = data && typeof data.detail === 'string'
      ? data.detail
      : (data && typeof data.message === 'string' ? data.message : `エラーが発生しました (${response.status})`);
    if (response.status === 401) {
      clearAuthToken();
      sessionStorage.removeItem('diagnostic-session');
      window.dispatchEvent(new CustomEvent('auth:expired', { detail: { message } }));
    }
    throw new Error(message);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    return (await response.json()) as T;
  }


  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: T | null = null;
  let resultReceived = false;

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) return;
    let event;
    try {
      event = JSON.parse(jsonStr);
    } catch (err) {
      if (err instanceof SyntaxError) return;
      throw err;
    }
    // Server errors and callback errors must never be mistaken for parse errors.
    if (event.type === 'progress' && onProgress) {
      onProgress({agent:event.agent,stage:event.stage,message:event.message,
        concept_id:event.concept_id,concept_name:event.concept_name,job_id:event.job_id});
    } else if (event.type === 'result') {
      finalResult = event.data as T;
      resultReceived = true;
    } else if (event.type === 'error') {
      throw new Error(event.detail || '処理中にエラーが発生しました');
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const line of buffer.split('\n')) consumeLine(line);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) consumeLine(line);
      // The result event is terminal. A proxy may keep the HTTP stream open
      // briefly after sending it, so do not make the UI wait for EOF.
      if (resultReceived) {
        try { await reader.cancel(); } catch { /* The result is already complete. */ }
        return finalResult as T;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finalResult === null) {
    throw new Error('サーバーからの完了レスポンスを受信できませんでした。');
  }

  return finalResult;
}

