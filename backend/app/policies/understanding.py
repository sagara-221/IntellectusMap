# ==============================================================================
# 理解度集計・ロールアップポリシー (Understanding Summary Policy)
# 用途: 診断問題への回答エビデンス、自己評価アンケート、および下位子ノードの集計値（ロールアップ）を
#       組み合わせてツリー全体の理解度ステータスを算出
# ==============================================================================
from collections import Counter
from app.models.domain import Session
from app.policies.conversation import estimates
from app.policies.knowledge_graph import hierarchy, reachable

# 自己評価（high, medium, low）のデフォルト仮推定スコア
SELF_SCORES = {'high': .9, 'medium': .55, 'low': .2}
SELF_REPORT_CONFIDENCE = .25


def confidence_level(score: float | None) -> str:
    """理解度スコアの数値から定性レベル（high, medium, low, unknown）を算出。"""
    if score is None:
        return 'unknown'
    if score >= .7:
        return 'high'
    if score >= .4:
        return 'medium'
    return 'low'


def summaries(session: Session) -> dict[str, dict]:
    """セッション内の全概念ノードについて、直接評価および子孫ロールアップを含む理解度サマリを生成。"""
    nodes, _ = hierarchy(session)
    children = {identifier: set() for identifier in nodes}
    # Keep the stored tree first. Ignore corrupt secondary cycles in old data
    # for presentation; merge checks reject them before creating new data.
    relations = [(node.concept_id, child.concept_id) for node in nodes.values() for child in node.child_nodes]
    relations.extend(sorted({(edge.source, edge.target) for edge in session.concept_edges if edge.relation == 'part'}))
    for source, target in relations:
        if source in nodes and target in nodes and not reachable(children, target, source):
            children[source].add(target)

    question_counts = Counter(e.concept_id for e in session.evidence)

    def scope(identifier):
        found = set()
        pending = [identifier]
        while pending:
            current = pending.pop()
            if current in found:
                continue
            found.add(current)
            pending.extend(children[current] - found)
        return found

    direct = {}
    direct_sources = {}
    conversation = estimates(session)
    for identifier, node in nodes.items():
        survey = session.self_assessments.get(identifier)
        answered = [e for e in session.evidence if e.concept_id == identifier and e.correctness != 'ungradable']
        if identifier in conversation:
            estimate = conversation[identifier]
            score, source, confidence = estimate['score'], estimate['source'], estimate['confidence']
        elif answered:
            score = sum(e.score for e in answered) / len(answered)
            source = 'question'
            state = session.learning_states.get(identifier)
            confidence = state.diagnostic_confidence if state else 0
        elif survey and survey.level in SELF_SCORES:
            score = SELF_SCORES[survey.level]
            source = 'self_report'
            confidence = SELF_REPORT_CONFIDENCE
        else:
            score = None
            source = 'needs_question' if survey and survey.level == 'unsure' else 'not_answered'
            confidence = None
        direct[identifier] = (score, source, confidence)
        direct_sources[identifier] = (['question', 'conversation'] if source == 'mixed' else
            [source] if source in ('question', 'conversation', 'self_report') else [])

    result = {}
    contributors = {}
    visiting = set()

    def resolve(identifier):
        if identifier in result:
            return result[identifier]
        own_score, own_source, own_confidence = direct[identifier]
        # A merged concept can be reached by several parents. Guard against a
        # malformed cycle in relation edges without blocking the entire summary.
        if identifier in visiting:
            return {'score': own_score, 'confidence_score': own_confidence}
        visiting.add(identifier)
        child_results = [resolve(child) for child in sorted(children[identifier]) if child != identifier]
        visiting.remove(identifier)
        assessed = sum(child['score'] is not None for child in child_results)
        total = len(child_results)
        if total and assessed == total:
            # Aggregate unique underlying estimates, not repeated branch means.
            sources = {}
            for child in children[identifier]:
                sources.update(contributors[child])
            score = sum(value[0] for value in sources.values()) / len(sources)
            confidence = sum(value[1] for value in sources.values()) / len(sources)
            contributors[identifier] = sources
            source = 'descendants'
        else:
            score, source, confidence = own_score, own_source, own_confidence
            contributors[identifier] = {identifier: (score, confidence or 0)} if score is not None else {}
            if total and score is None and assessed:
                source = 'descendants'
                confidence = sum(child['confidence_score'] or 0 for child in child_results) / total
        if not total:
            assessed = int(score is not None)
            total = 1
        contributing = contributors[identifier]
        evidence_sources = sorted({source for cid in contributing for source in direct_sources[cid]})
        provisional = bool(contributing) and all(conversation.get(cid, {}).get('provisional', False)
                                                 for cid in contributing)
        level = ('high' if score >= .8 else 'low' if score < .4 else 'medium') if score is not None else 'unknown'
        result[identifier] = {
            'level': level,
            'score': score,
            'confidence_score': confidence,
            'confidence_level': confidence_level(confidence),
            'source': source,
            'evidence_sources': evidence_sources,
            'provisional': provisional,
            'assessed': assessed,
            'total': total,
            'missing': total - assessed,
        }
        return result[identifier]

    for identifier in nodes:
        resolve(identifier)
        related = scope(identifier)
        result[identifier]['question_answers'] = sum(question_counts[child] for child in related)
        result[identifier]['survey_answers'] = sum(child in session.self_assessments for child in related)
        result[identifier]['conversation_answers'] = len({ref.message_id for item in session.chat.observations
            if item.concept_id in related for ref in item.citations})
    return result
