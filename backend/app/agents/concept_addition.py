# ==============================================================================
# 概念追加エージェント (ConceptAdditionAgent)
# 用途: ユーザーが手動追加したい概念の名称・メモから、ツリーに適した属性・目標・前提関係を補完生成
# ==============================================================================
import unicodedata

from app.llm.base import LLMError, LLMService
from app.models.domain import AdditionInput, ConceptSpec


def normalized_name(value: str) -> str:
    """空白・大文字小文字・全角半角を揃えて比較用名称を正規化。"""
    return ''.join(unicodedata.normalize('NFKC', value).casefold().split())


class ConceptAdditionAgent:
    """ユーザー指定の追加概念の属性（説明、到達目標、粒度等）を推論生成するエージェント"""
    def __init__(self, llm: LLMService):
        self.llm = llm

    async def run(self, request: AdditionInput) -> ConceptSpec:
        """追加概念仕様をLLMで生成し、前提関係や重複をバリデーションして返却。"""
        result = await self.llm.generate('addition', request, ConceptSpec, .2)
        # サーバー側で発行した一意IDを強制適用
        result = ConceptSpec.model_validate({**result.model_dump(),
            'concept_id': request.concept_id})
        if len(result.concept_name) > 120:
            raise LLMError('AIが生成した項目名が長すぎます。再試行してください。')
        if any(identifier not in request.existing_concept_ids
               for identifier in result.prerequisite_concept_ids):
            raise LLMError('追加項目の前提知識に、存在しない項目が含まれています。再試行してください。')
        if any(normalized_name(result.concept_name) == normalized_name(sibling.concept_name)
               for sibling in request.siblings):
            raise ValueError('AIが既存の子項目と同じ名前を提案しました。補足を詳しくして再試行してください。')
        return result

