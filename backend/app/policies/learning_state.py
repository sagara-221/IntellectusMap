# ==============================================================================
# 学習状態（LearningState）判定ポリシー
# 用途: 収集された回答エビデンス（正誤・確信度・所要時間）を集計し、
#       各観点（Target）および概念ノード全体の理解度スコアと状態遷移（mastered/weak/learning等）を計算
# ==============================================================================
from app.models.domain import Evidence, LearningState, Node, PolicyConfig, TargetState

# ノード粒度（broad/medium/narrow）ごとの基礎要求観測回数
BASE_QUESTIONS = {'broad': 5, 'medium': 3, 'narrow': 2}


def status(score: float | None, confidence: float, config: PolicyConfig) -> str:
    """理解度スコアと確信度から学習ステータス（Status）を算出。"""
    if score is None:
        return 'not_assessed'
    if confidence < config.confidence_threshold:
        return 'uncertain'
    if score >= config.mastery_threshold:
        return 'mastered'
    if score < config.weak_threshold:
        return 'weak'
    return 'learning'


def update(node: Node, evidence: list[Evidence], config: PolicyConfig) -> LearningState:
    """概念ノードに紐づくエビデンス群からLearningStateを再計算・更新。"""
    own = [e for e in evidence if e.concept_id == node.concept_id]
    state = LearningState(concept_id=node.concept_id, questions_answered=len(own),
                          correct_count=sum(e.correctness == 'correct' for e in own),
                          evidence_ids=[e.evidence_id for e in own])

    # 観点あたり最低2回、または粒度に応じた基礎出題数から必要観測数を算出
    required = max(2, BASE_QUESTIONS[node.granularity] / len(node.assessment_targets))
    weighted_scores, score_weight, weighted_conf, all_weight = 0., 0., 0., 0.

    # 1. 各評価観点（Target）単位でのスコアリングと確信度計算
    for target in node.assessment_targets:
        observations = [e for e in own if e.assessment_target_id == target.target_id]
        usable = [e for e in observations if e.correctness != 'ungradable' and e.evaluation_confidence > 0]
        total = sum(e.evaluation_confidence for e in usable)
        score = sum(e.score * e.evaluation_confidence for e in usable) / total if total else None
        confidence = (total / len(usable)) * min(1, len(usable) / required) if usable else 0
        ts = TargetState(target_id=target.target_id, understanding_score=score,
                         diagnostic_confidence=confidence, questions_answered=len(observations),
                         correct_count=sum(e.correctness == 'correct' for e in observations),
                         status=status(score, confidence, config), evidence_ids=[e.evidence_id for e in observations])
        state.target_states[target.target_id] = ts
        weight = 1 if target.importance == 'core' else .5
        all_weight += weight
        weighted_conf += confidence * weight
        if score is not None:
            weighted_scores += score * weight
            score_weight += weight

    # 2. 概念ノード全体の総合スコア・確信度・ステータス集計
    state.understanding_score = weighted_scores / score_weight if score_weight else None
    state.diagnostic_confidence = weighted_conf / all_weight
    state.status = status(state.understanding_score, state.diagnostic_confidence, config)

    # 重要観点（core）に弱点がある場合、平均値が高くても習得（mastered）にせず学習中（learning）に留める
    if state.status == 'mastered' and any(t.importance == 'core' and state.target_states[t.target_id].status != 'mastered' for t in node.assessment_targets):
        state.status = 'learning'
    if own and state.understanding_score is None:
        state.status = 'uncertain'

    # 3. 検出された誤解（Misconception）の重複排除リスト構築
    seen = set()
    for e in own:
        for m in e.misconception_candidates:
            if m.description not in seen:
                state.detected_misconceptions.append(m)
                seen.add(m.description)
    return state

