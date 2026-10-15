"""All hierarchy paths, including shared part relations, participate in checks."""


def hierarchy(session):
    nodes, children, pending = {}, {}, [session.knowledge_tree]
    while pending:
        node = pending.pop()
        if node.concept_id in nodes:
            continue
        nodes[node.concept_id] = node
        children[node.concept_id] = {child.concept_id for child in node.child_nodes}
        pending.extend(node.child_nodes)
    for edge in session.concept_edges:
        if edge.relation == 'part' and edge.source in nodes and edge.target in nodes:
            children[edge.source].add(edge.target)
    return nodes, children


def reachable(children, source, target):
    seen, pending = set(), [source]
    while pending:
        current = pending.pop()
        if current == target:
            return True
        if current not in seen:
            seen.add(current)
            pending.extend(children.get(current, ()))
    return False


def acyclic(children):
    indegree = dict.fromkeys(children, 0)
    for targets in children.values():
        for target in targets:
            indegree[target] = indegree.get(target, 0) + 1
    pending = [key for key, degree in indegree.items() if degree == 0]
    count = 0
    while pending:
        current = pending.pop()
        count += 1
        for target in children.get(current, ()):
            indegree[target] -= 1
            if indegree[target] == 0:
                pending.append(target)
    return count == len(indegree)


def validate_merge_structure(session, parent_id, existing_id, incoming_id, promote=False, retain_parent=True):
    nodes, children = hierarchy(session)
    root = session.knowledge_tree.concept_id
    if (parent_id not in nodes or existing_id not in nodes or existing_id == incoming_id
            or root in (existing_id, incoming_id)):
        raise ValueError('Invalid hierarchy merge endpoints')
    replacement = lambda value: existing_id if value == incoming_id else value
    proposed = {replacement(key): set() for key in children}
    for source, targets in children.items():
        for target in targets:
            if promote and target == existing_id:
                continue
            if not retain_parent and target == incoming_id:
                continue
            proposed[replacement(source)].add(replacement(target))
    if promote or retain_parent:
        proposed[replacement(parent_id)].add(existing_id)
    if not acyclic(proposed):
        raise ValueError('Concept merge would create a hierarchy cycle')
