# ==============================================================================
# 診断問題生成エージェント (QuestionAgent)
# 用途: 選択された概念と到達目標に沿った診断問題をLLMで生成し、重複を検知・除外する
# ==============================================================================
from app.models.domain import Question, QuestionContent, QuestionBatchContent, QuestionInput
from app.llm.base import LLMError, LLMService


def is_duplicate_question(candidate_text: str, existing_texts: list[str]) -> bool:
    """過去の出題テキスト群と比較し、空白・記号正規化後の同一性を判定。
    
    Args:
        candidate_text: 新規生成された問題文
        existing_texts: 過去に出題済みの問題文リスト
    Returns:
        bool: 重複と判定された場合True
    """
    c_raw = candidate_text.strip().casefold()
    c_clean = "".join(c for c in c_raw if c.isalnum())
    if not c_clean:
        return False
    for ex in existing_texts:
        ex_raw = ex.strip().casefold()
        if c_raw == ex_raw:
            return True
        ex_clean = "".join(c for c in ex_raw if c.isalnum())
        if c_clean == ex_clean:
            return True
    return False


class QuestionAgent:
    """診断問題の単問生成およびバッチ生成を担当するエージェント"""
    def __init__(self, llm: LLMService):
        self.llm = llm

    async def run(self, request: QuestionInput) -> Question:
        """指定された概念・評価目標に対して単一の診断問題を生成（最大2回リトライ）。"""
        for _ in range(2):
            content = await self.llm.generate('question', request, QuestionContent, .5)
            if content.question_type == request.request.question_type and not is_duplicate_question(content.question_text, request.previous_question_summaries):
                return Question(**content.model_dump(), concept_id=request.concept.concept_id,
                                assessment_target_id=request.request.assessment_target_id,
                                difficulty=request.request.difficulty)
        raise LLMError('指定形式の新しい問題を生成できませんでした。再試行してください。')

    async def run_batch(self, request: QuestionInput) -> list[Question]:
        """一括で複数問を生成し、過去問および同一バッチ内での重複を除いたQuestionリストを返却。"""
        expected_type = request.request.question_type
        previous = list(request.previous_question_summaries)

        for _ in range(2):
            result = await self.llm.generate('question', request, QuestionBatchContent, .5)
            if isinstance(result, QuestionBatchContent):
                candidates = result.questions
            elif isinstance(result, QuestionContent):
                candidates = [result]
            elif isinstance(result, list):
                candidates = result
            else:
                candidates = []

            valid_questions: list[Question] = []
            seen_texts: list[str] = list(previous)

            for content in candidates:
                if content.question_type != expected_type:
                    continue
                if is_duplicate_question(content.question_text, seen_texts):
                    continue

                q = Question(
                    **content.model_dump(),
                    concept_id=request.concept.concept_id,
                    assessment_target_id=request.request.assessment_target_id,
                    difficulty=request.request.difficulty,
                )
                valid_questions.append(q)
                seen_texts.append(content.question_text)

            if valid_questions:
                return valid_questions

        raise LLMError('指定形式の新しい問題を生成できませんでした。再試行してください。')


