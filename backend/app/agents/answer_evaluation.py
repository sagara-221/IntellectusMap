# ==============================================================================
# 回答評価エージェント (EvaluationAgent)
# 用途: ユーザーの解答を照合またはLLM意味採点し、エビデンス（正誤、確信度、誤解）を算出
# ==============================================================================
import re
import unicodedata
from app.models.domain import Evaluation, EvaluationInput, Evidence, Misconception
from app.llm.base import LLMError, LLMService


def normalize(text: str) -> str:
    """NFKC正規化を行い、全空白を除去して照合用の正規化文字列を作成。"""
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text))


class EvaluationAgent:
    """選択肢一致・完全一致ルールベース採点、およびLLMによる自由記述意味採点を実行"""
    def __init__(self, llm: LLMService):
        self.llm = llm

    async def run(self, request: EvaluationInput) -> Evidence:
        """ユーザー回答を評価し、診断根拠エビデンス（Evidence）を生成。"""
        q = request.question
        method = q.grading_type

        # 1. 選択肢一致（choice_match）または完全一致（exact_match）の決定論的評価
        if q.grading_type in ('choice_match', 'exact_match'):
            correct = normalize(request.user_answer) in [normalize(a) for a in q.expected_answer]
            misconceptions = [Misconception(description=m.misconception, confidence=.6)
                for m in q.diagnostic_mapping if normalize(m.answer) == normalize(request.user_answer)] if not correct else []
            result = Evaluation(correctness='correct' if correct else 'incorrect', score=1 if correct else 0,
                evaluation_confidence=1, demonstrated_knowledge=[q.answer_explanation] if correct else [],
                missing_knowledge=[] if correct else [q.answer_explanation], misconception_candidates=misconceptions,
                needs_additional_assessment=not correct)
        else:
            # 2. 自由記述・数式等の意味論的評価（LLM推論による採点）
            # セキュリティ上、evalやsympifyは行わず明示的なLLMセマンティック評価にフォールバック
            method = 'semantic_evaluation' if method != 'symbolic_match' else 'semantic_fallback_for_symbolic'
            try:
                result = await self.llm.generate('evaluation', request, Evaluation, .1)
            except LLMError:
                result = Evaluation(correctness='ungradable', score=0, evaluation_confidence=0,
                    missing_knowledge=['自動採点できませんでした。別の問題で確認します。'], needs_additional_assessment=True)

        return Evidence(**result.model_dump(), question_id=q.question_id, concept_id=q.concept_id,
            assessment_target_id=q.assessment_target_id, user_answer=request.user_answer,
            user_confidence=request.user_confidence, answer_time_ms=request.answer_time_ms, grading_method=method)

