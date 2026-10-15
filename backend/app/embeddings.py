"""概念（Concept）の埋め込みベクトル（Embedding）生成モジュール。

- 知識マップ内の概念同士の意味的類似度を計算し、重複排除（マージ）を行うために利用。
- セッション本体とは独立した内部インデックスとして管理。
"""
import hashlib
import math
from typing import Protocol
from urllib.parse import quote
import httpx
from app.config import Settings
from app.llm.vertex_auth import VertexAuth


def concept_text(theme, concept, parent_name):
    """概念の意味をベクトル化するための統合テキスト表現を生成。

    テーマ、概念名、説明文、評価対象（到達目標）、親ノードの文脈を結合し、
    文脈依存の意味も含めて高精度に類似判定できるようにする。
    """
    targets = '\n'.join(f'- {target.description}' for target in concept.assessment_targets)
    return (f'Theme:\n{theme}\n\nConcept:\n{concept.concept_name}\n\n'
            f'Description:\n{concept.description}\n\nLearning Targets:\n{targets}\n\n'
            f'Parent Context:\n{parent_name or "(root)"}')


def text_hash(value):
    """キャッシュキー生成用の SHA-256 ハッシュ"""
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def cosine(a, b):
    """2つのベクトル間のコサイン類似度を計算（範囲: -1.0 〜 1.0）"""
    if not a or len(a) != len(b):
        return 0.0
    denom = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    return sum(x*y for x, y in zip(a, b)) / denom if denom else 0.0


class EmbeddingProvider(Protocol):
    """埋め込みベクトル生成プロバイダーの共通インターフェース"""
    model: str
    async def embed(self, text: str) -> list[float]: ...


class GoogleEmbeddingProvider:
    """Google Cloud Vertex AI (Predict API) を用いたベクトル生成。"""
    def __init__(self, settings: Settings, transport=None, auth=None):
        self.settings = settings
        self.model = settings.embedding_model
        self.transport = transport
        self.auth = auth or VertexAuth(settings)

    async def embed(self, text: str) -> list[float]:
        """指定テキストの 768次元 埋め込みベクトルを取得"""
        model = quote(self.model, safe='')
        if self.settings.embedding_backend == 'auto' and self.settings.gemini_backend == 'agent_platform':
            url = f'https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:predict'
            headers = {'x-goog-api-key': self.settings.gemini_api_key}
        else:
            _, project = self.settings.vertex_configuration()
            location = self.settings.embedding_location
            host = 'aiplatform.googleapis.com' if location == 'global' else f'{location}-aiplatform.googleapis.com'
            url = f'https://{host}/v1/projects/{quote(project, safe="")}/locations/{location}/publishers/google/models/{model}:predict'
            headers = await self.auth.headers()
        # 768次元に固定して計算コストと保存容量を最適化
        body = {'instances': [{'content': text}], 'parameters': {'outputDimensionality': 768}}
        async with httpx.AsyncClient(timeout=self.settings.embedding_timeout_seconds, transport=self.transport) as client:
            response = await client.post(url, headers=headers, json=body)
            response.raise_for_status()
            result = response.json()
        vector = result['predictions'][0]['embeddings']['values']
        if not vector or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector):
            raise ValueError('Invalid embedding vector')
        return [float(x) for x in vector]


class DemoEmbeddingProvider:
    """ローカルテスト用の決定論的擬似埋め込みベクトルプロバイダー。

    外部APIを呼び出さずに、文字N-gramハッシュ（NFKC正規化+Blake2b）を用いて
    固定長（256次元）の頻度ベクトルを生成し、テスト時の類似度判定を再現。
    """
    model = 'demo-character-ngrams-v2'

    async def embed(self, text: str) -> list[float]:
        """文字N-gram頻度によるローカル擬似埋め込みベクトル生成"""
        import unicodedata
        # 全角半角統一および小文字化
        normalized = unicodedata.normalize('NFKC', text).casefold()
        # テストケース向けの同義語置換
        normalized = normalized.replace('チェーンルール', '連鎖律').replace('supervised learning', '教師あり学習')
        vector = [0.0] * 256
        # 2-gramおよび3-gramをハッシュバケットにカウント
        for size in (2, 3):
            for index in range(len(normalized) - size + 1):
                token = normalized[index:index+size]
                bucket = int.from_bytes(hashlib.blake2b(token.encode(), digest_size=2).digest(), 'big') % len(vector)
                vector[bucket] += 1
        return vector
