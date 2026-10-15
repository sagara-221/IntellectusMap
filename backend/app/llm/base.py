# ==============================================================================
# LLMサービス基底インターフェース
# 用途: Gemini API, Vertex AI, デモモックなどのLLM呼び出しを抽象化するProtocol
# ==============================================================================
from typing import AsyncIterator, Protocol, TypeVar
from pydantic import BaseModel

T = TypeVar('T', bound=BaseModel)


class LLMError(Exception):
    """LLM呼び出し失敗、タイムアウト、スキーマ不整合などの共通エラー例外"""
    pass


class LLMService(Protocol):
    """構造化出力およびストリーミングを生成するLLMサービスの共通プロトコル"""
    async def generate(self, agent: str, payload: BaseModel, schema: type[T], temperature: float) -> T:
        """指定されたエージェントプロンプトと入力モデルから構造化出力を生成。
        
        Args:
            agent: プロンプトテンプレート名（エージェント種別）
            payload: LLM入力データモデル
            schema: 生成結果をマッピングするPydanticモデルクラス
            temperature: サンプリング温度（0.0〜1.0）
        Returns:
            T: schemaで検証・復元されたインスタンス
        Raises:
            LLMError: API呼び出しやデシリアライズに失敗した場合
        """
        ...

    def stream_text(self, agent: str, payload: BaseModel, temperature: float) -> AsyncIterator[str]:
        """チャット等のテキストストリーミング出力を非同期イテレータとして生成。"""
        ...
