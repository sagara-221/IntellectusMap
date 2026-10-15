"""Combine auditable conversation observations with existing question evidence."""
from app.policies.learning_state import status

PROVISIONAL_CREATION_REASON = '発言から作成した項目の暫定推定。理解度は未検証です。'
PROVISIONAL_CREATION_SCORE = .5


def observation_score(observation):
    return PROVISIONAL_CREATION_SCORE if observation.reason == PROVISIONAL_CREATION_REASON else observation.score


def public_observation(observation):
    return {**observation.model_dump(), 'score': observation_score(observation)}


def assessed_ids(session):
    return {item.concept_id for item in session.chat.observations
            if item.kind != 'self_report' and item.confidence >= .4}


def estimates(session):
    result = {}
    message_times = {item.message_id: item.created_at for item in session.chat.messages if item.role == 'user'}
    nodes = []
    def visit(node):
        nodes.append(node)
        for child in node.child_nodes:
            visit(child)
    visit(session.knowledge_tree)
    for node in nodes:
        observations = [item for item in session.chat.observations if item.concept_id == node.concept_id]
        if any(item.reason != PROVISIONAL_CREATION_REASON for item in observations) or any(
                item.concept_id == node.concept_id and item.correctness != 'ungradable'
                for item in session.evidence) or (node.concept_id in session.self_assessments
                and session.self_assessments[node.concept_id].level in ('high', 'medium', 'low')):
            observations = [item for item in observations if item.reason != PROVISIONAL_CREATION_REASON]
        if not observations:
            continue
        targets = {}
        for target in node.assessment_targets:
            events = [(item.answered_at or '', item.score, item.evaluation_confidence, item.evidence_id)
                      for item in session.evidence if item.concept_id == node.concept_id
                      and item.assessment_target_id == target.target_id and item.correctness != 'ungradable']
            # Reassessing the same passage after expansion must not increase certainty.
            unique = {}
            for item in observations:
                if item.target_id == target.target_id:
                    key = tuple(sorted({ref.message_id for ref in item.citations}))
                    unique[key] = item
            events.extend((max(message_times.get(ref.message_id, item.created_at) for ref in item.citations),
                           observation_score(item),
                           min(item.confidence, .25) if item.kind == 'self_report' else item.confidence,
                           item.observation_id) for item in unique.values())
            events.sort(key=lambda item: item[0], reverse=True)
            weighted = [(event, .6 ** index) for index, event in enumerate(events) if event[2] > 0]
            total = sum(event[2] * weight for event, weight in weighted)
            score = sum(event[1] * event[2] * weight for event, weight in weighted) / total if total else None
            confidence = total / sum(weight for _, weight in weighted) * min(1, len(weighted) / 2) if weighted else 0
            if len(events) > 1 and abs(events[0][1] - events[1][1]) > .45:
                confidence = min(confidence * .65, .35)
            targets[target.target_id] = dict(score=score, confidence=confidence,
                status=status(score, confidence, session.config))
        known = [(target, targets[target.target_id]) for target in node.assessment_targets
                 if targets[target.target_id]['score'] is not None]
        weight = lambda target: 1 if target.importance == 'core' else .5
        score = sum(item['score'] * weight(target) for target, item in known) / sum(weight(target) for target, _ in known) if known else None
        confidence = sum(targets[target.target_id]['confidence'] * weight(target) for target in node.assessment_targets) / sum(weight(target) for target in node.assessment_targets)
        result[node.concept_id] = dict(score=score, confidence=confidence, targets=targets,
            provisional=all(item.reason == PROVISIONAL_CREATION_REASON for item in observations),
            status=status(score, confidence, session.config), source='mixed' if any(
                item.concept_id == node.concept_id and item.correctness != 'ungradable' for item in session.evidence) else 'conversation')
    # Older maps and automatically expanded chat branches may have no usable
    # judgment. Give those nodes a visible baseline without inventing evidence.
    created = set(session.chat.created_concept_ids)
    def mark_branch(node, inherited=False):
        from_chat = node.depth > 0 and (inherited or node.concept_id in created or node.creation_source == 'chat')
        if from_chat:
            created.add(node.concept_id)
        for child in node.child_nodes:
            mark_branch(child, from_chat)
    mark_branch(session.knowledge_tree)
    for node in nodes:
        cid = node.concept_id
        if (node.depth == 0 or (cid not in created and node.creation_source != 'chat')
                or result.get(cid, {}).get('score') is not None
                or any(item.concept_id == cid and item.correctness != 'ungradable' for item in session.evidence)
                or (cid in session.self_assessments and session.self_assessments[cid].level in ('high', 'medium', 'low'))):
            continue
        result[cid] = dict(score=PROVISIONAL_CREATION_SCORE, confidence=.1, provisional=True, source='conversation',
            status=status(PROVISIONAL_CREATION_SCORE, .1, session.config), targets={})
    return result


def learning_states(session):
    states = {key: value.model_dump() for key, value in session.learning_states.items()}
    for concept_id, estimate in estimates(session).items():
        if concept_id not in states:
            continue
        state = states[concept_id]
        state.update(understanding_score=estimate['score'], diagnostic_confidence=estimate['confidence'], status=estimate['status'])
        for target_id, target in estimate['targets'].items():
            if target_id in state['target_states']:
                state['target_states'][target_id].update(understanding_score=target['score'], diagnostic_confidence=target['confidence'], status=target['status'])
    return states
