# ==============================================================================
# LLMテレメトリ・トークン使用量トラッキングモジュール
# 用途: 非同期コンテキスト変数を用いたセッション追跡、トークン消費量およびレイテンシ記録
# ==============================================================================
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable

# リクエストスコープごとの追跡コンテキスト (session_id, concept_id 等)
context = ContextVar('diagnostic_context', default={})
_usage_handlers: list[Callable] = []


def register_usage_handler(handler: Callable):
    """トークン使用量通知を受け取るコールバックハンドラーを登録。"""
    if handler not in _usage_handlers:
        _usage_handlers.append(handler)


def record_token_usage(agent_name: str, prompt_tokens: int, candidates_tokens: int, latency_ms: int = 0):
    """LLM呼び出しで消費されたトークン数とレイテンシを記録し、登録済みハンドラーへ通知。
    
    Args:
        agent_name: 呼び出し元エージェント名
        prompt_tokens: 入力プロンプトトークン数
        candidates_tokens: 出力生成トークン数
        latency_ms: 応答所要時間（ミリ秒）
    """
    ctx = context.get()
    session_id = ctx.get('session_id')
    concept_id = ctx.get('concept_id')
    if not session_id:
        return
    for handler in _usage_handlers:
        try:
            handler(session_id, agent_name, prompt_tokens, candidates_tokens, latency_ms, concept_id)
        except TypeError:
            try:
                handler(session_id, agent_name, prompt_tokens, candidates_tokens, latency_ms)
            except TypeError:
                handler(session_id, agent_name, prompt_tokens, candidates_tokens)
        except Exception:
            pass


@contextmanager
def trace(**fields):
    """コンテキスト変数にセッション情報等をセットするコンテキストマネージャ。
    
    Usage:
        with trace(session_id="...", concept_id="..."):
            ...
    """
    token = context.set({**context.get(), **fields})
    try:
        yield
    finally:
        context.reset(token)

