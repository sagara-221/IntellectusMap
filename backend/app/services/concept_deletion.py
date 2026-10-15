"""Remove local graph references while retaining original conversation messages."""


def prune_deleted(session):
    removed = set(session.deleted_concept_ids)
    if not removed:
        return
    def prune(node):
        # Include new descendants attached by an old, concurrently running task.
        for child in node.child_nodes:
            if node.concept_id in removed:
                removed.add(child.concept_id)
            prune(child)
        node.child_nodes = [child for child in node.child_nodes if child.concept_id not in removed]
    prune(session.knowledge_tree)
    session.deleted_concept_ids = sorted(removed)
    def walk(node):
        yield node
        for child in node.child_nodes:
            yield from walk(child)
    nodes = list(walk(session.knowledge_tree))
    live = {node.concept_id for node in nodes}
    for node in nodes:
        node.parent_ids = [cid for cid in node.parent_ids if cid in live]
        if node.parent_concept_id not in live:
            node.parent_concept_id = next(iter(node.parent_ids), None)
        node.prerequisite_concept_ids = [cid for cid in node.prerequisite_concept_ids if cid in live]
    session.concept_edges = [e for e in session.concept_edges if e.source in live and e.target in live]
    session.concept_redirects = {a: b for a, b in session.concept_redirects.items() if a not in removed and b not in removed}
    for field in ('learning_states', 'self_assessments', 'question_pool', 'paused_questions'):
        setattr(session, field, {cid: value for cid, value in getattr(session, field).items() if cid in live})
    session.questions = [q for q in session.questions if q.concept_id in live]
    session.evidence = [e for e in session.evidence if e.concept_id in live]
    qids = {q.question_id for q in session.questions}
    session.reassessment_question_ids = [qid for qid in session.reassessment_question_ids if qid in qids]
    for field in ('pending_question', 'pending_review', 'reassessment', 'next_action'):
        obj = getattr(session, field)
        if obj and getattr(obj, 'concept_id', None) in removed:
            setattr(session, field, None)
    for field in ('active_concept_id', 'approved_expansion_id'):
        if getattr(session, field) in removed:
            setattr(session, field, None)
    for field in ('queue', 'deferred_concepts', 'focused_path', 'completed_concepts'):
        setattr(session, field, [cid for cid in getattr(session, field) if cid in live])
    session.policy_history = [p for p in session.policy_history if p.concept_id not in removed]
    session.review_history = [r for r in session.review_history if r.review.concept_id not in removed]
    chat = session.chat
    chat.observations = [o for o in chat.observations if o.concept_id in live]
    if chat.focus_concept_id in removed:
        chat.focus_concept_id = None
    for field in ('created_concept_ids', 'generating_concept_ids', 'opened_concept_ids', 'pending_node_ids', 'failed_node_ids'):
        setattr(chat, field, [cid for cid in getattr(chat, field) if cid in live])
    for item in chat.evidence_queue:
        touched = False
        for field in ('matched_concept_ids', 'detail_concept_ids', 'added_concept_ids', 'pending_expansion_ids'):
            ids = getattr(item, field)
            touched |= bool(removed.intersection(ids))
            setattr(item, field, [cid for cid in ids if cid in live])
        if touched:
            item.status = 'ignored'
            item.reason = '関連する項目を削除したため、この根拠の自動反映を停止しました。'
            item.pending_addition_keys = []
    for job in chat.jobs:
        for field in ('planned_expansions', 'related_concept_ids', 'updated_concept_ids', 'completed_expansions', 'pending_expansions'):
            setattr(job, field, [cid for cid in getattr(job, field) if cid in live])
        job.planned_additions = [a for a in job.planned_additions if a.parent_concept_id in live]
        job.planned_links = [link for link in job.planned_links if link.concept_id in live]
    # Routing caches are invalidated when deleting, not on every later save.
    # Their context hashes already invalidate old topology on normal reads.
