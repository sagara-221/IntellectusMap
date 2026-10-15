# ==============================================================================
# 診断出題ポリシーモジュール (Diagnostic Policy)
# 用途: 概念の学習状態、回答数、深さ、目標に基づいて次のアクション（出題、深掘り、次概念移動等）を決定
# ==============================================================================
from app.models.domain import LearningState, Node, Plan, PolicyConfig, QuestionRequest
from app.policies.learning_state import BASE_QUESTIONS

# 知識タイプ（fact/concept/calc/procedure/apply）に応じた出題形式の推奨マッピング
FORMATS = {
    'factual': ('multiple_choice', 'yes_no'),
    'conceptual': ('multiple_choice', 'short_explanation'),
    'calculation': ('short_answer', 'free_response'),
    'procedural': ('multiple_choice', 'short_answer'),
    'application': ('short_answer', 'free_response'),
}


def decide(node: Node, state: LearningState, total: int, config: PolicyConfig, answer_format: str = 'auto', allowed_question_types: list[str] | None = None) -> Plan:
    """現在のノード状態から次に行うべき診断プラン（Plan）を決定。
    
    - セッション上限到達 -> complete
    - 習得確認済み（mastered） -> move_to_next_concept
    - レビュー条件合致 -> review_findings
    - 弱点検出時（weak） -> 子ノードへの深掘り（expand_concept）または次へ移動
    - 概念あたりの出題数上限到達 -> move_to_next_concept
    - それ以外 -> 問題出題（question_plan）
    """
    def plan(action, reason, **kwargs):
        return Plan(action=action, concept_id=node.concept_id, reason_code=reason, **kwargs)

    # 1. セッション全体の総出題数上限チェック
    if config.max_total_questions is not None and total >= config.max_total_questions:
        return plan('complete', 'SESSION_LIMIT')

    # 2. 習得完了時
    if state.status == 'mastered':
        return plan('move_to_next_concept', 'MASTERY_CONFIRMED')

    # 3. レビュー要件（深さおよび弱点・上限）
    if node.depth >= config.review_min_depth and (state.status == 'weak' or state.questions_answered >= config.max_questions_per_concept):
        return plan('review_findings', 'USER_REVIEW_REQUIRED')

    # 4. 弱点判定時の深掘り（expand）判断
    if state.status == 'weak':
        if node.child_candidates and (config.max_depth is None or node.depth < config.max_depth) and not node.child_nodes:
            weakest = min(state.target_states.values(), key=lambda t: t.understanding_score if t.understanding_score is not None else 1)
            return plan('expand_concept', 'LOW_SCORE_HIGH_CONFIDENCE', expand_target_id=weakest.target_id)
        return plan('move_to_next_concept', 'MAX_DEPTH' if config.max_depth is not None and node.depth >= config.max_depth else 'WEAK_IDENTIFIED')

    # 5. 概念ごとの出題上限到達時
    if state.questions_answered >= config.max_questions_per_concept:
        return plan('move_to_next_concept', 'CONCEPT_QUESTION_LIMIT')

    # 6. 継続出題の生成
    return question_plan(node, state, config, answer_format, allowed_question_types)


def question_plan(node: Node, state: LearningState, config: PolicyConfig, answer_format: str = 'auto', allowed_question_types: list[str] | None = None, reassess: bool = False) -> Plan:
    """最適な評価目標（Target）を選定し、適切な問題形式の出題プランを策定。"""
    # 再診断時は確信度が最も低い観点を優先、通常時は未出題・出題回数が少ない観点を優先
    if reassess:
        target = min(node.assessment_targets, key=lambda t: (
            state.target_states[t.target_id].diagnostic_confidence,
            state.target_states[t.target_id].questions_answered, t.importance != 'core'))
    else:
        target = min(node.assessment_targets, key=lambda t: (state.target_states[t.target_id].questions_answered, t.importance != 'core'))

    count = state.target_states[target.target_id].questions_answered
    formats = FORMATS[target.knowledge_type]

    # 出題形式フィルタリング
    if allowed_question_types is not None:
        permitted = [f for f in allowed_question_types if target.knowledge_type != 'factual' or f in ('multiple_choice', 'yes_no')]
        if not permitted:
            raise ValueError('この評価観点に使える回答形式が選択されていません。')
        formats = tuple(f for f in formats if f in permitted) or tuple(permitted)
    elif answer_format == 'choice':
        formats = ('multiple_choice', 'yes_no')
    elif answer_format == 'written' and target.knowledge_type != 'factual':
        formats = ('short_explanation', 'free_response') if target.knowledge_type == 'conceptual' else ('short_answer', 'free_response')

    fmt = formats[count % len(formats)]
    return Plan(action='assess' if not state.questions_answered else 'continue_assessment', concept_id=node.concept_id,
                reason_code='USER_REQUESTED_REASSESSMENT' if reassess else
                    'INITIAL_SCREENING' if state.questions_answered < BASE_QUESTIONS[node.granularity] else 'MORE_EVIDENCE_REQUIRED',
                question_requests=[QuestionRequest(assessment_target_id=target.target_id, question_type=fmt,
                    purpose='mastery_check' if reassess or count else 'screening')])

