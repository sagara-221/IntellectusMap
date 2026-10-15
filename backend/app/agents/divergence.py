# ==============================================================================
# 展開マップ候補生成エージェント (DivergenceAgent)
# 用途: 特定概念から派生可能な新規学習テーマ（展開ノード）を複数件提案する
# ==============================================================================
import unicodedata

from app.llm.base import LLMError, LLMService
from app.models.maps import DivergenceInput, DivergenceOutput


def normalized_divergence_name(name: str) -> str:
    return ''.join(unicodedata.normalize('NFKC', name).casefold().split())


class DivergenceAgent:
    """知識の派生・広がりを促す展開マップ候補を生成するエージェント"""
    def __init__(self, llm: LLMService):
        self.llm = llm

    async def run(self, request: DivergenceInput) -> DivergenceOutput:
        """指定概念を起点とした展開候補を生成し、重複や祖先ノードとの被りを検証して返却。"""
        for _ in range(2):
            result = await self.llm.generate('divergence', request, DivergenceOutput, .4)
            names = {normalized_divergence_name(name) for name in
                     [*request.concept_path, *request.existing_map_themes,
                      *(item.name for item in request.previous_candidates)]}
            if (len(result.divergent_nodes) == request.candidate_count
                    and len({normalized_divergence_name(node.name) for node in result.divergent_nodes}) == request.candidate_count
                    and all(normalized_divergence_name(node.name) not in names for node in result.divergent_nodes)):
                return result
            request = request.model_copy(update={'previous_candidates':
                [*request.previous_candidates, *result.divergent_nodes]})
        raise LLMError('指定件数の独立した展開候補を生成できませんでした。再試行してください。')
