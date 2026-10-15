import {flatten, type Diagnosis} from './types';

// A slow response must never roll the graph or the server's assessments back.
// Callers decide whether opening a different session was intentional.
export function reconcileSession(current: Diagnosis | null, next: Diagnosis): Diagnosis {
  if (!current || current.session_id === 'pending_initial') return next;
  if (current.session_id !== next.session_id || next.revision < current.revision) return current;
  if(current.agent_runtime && next.agent_runtime && current.agent_runtime.revision>next.agent_runtime.revision){
    return {...next,agent_runtime:current.agent_runtime,...(current.revision===next.revision?{question_statuses:current.question_statuses,decomposition_statuses:current.decomposition_statuses}:{})};
  }
  return next;
}

export function redirectedId(session: Diagnosis, id: string | null): string | null {
  const visited = new Set<string>();
  while (id && session.concept_redirects?.[id] && !visited.has(id)) {
    visited.add(id); id = session.concept_redirects[id];
  }
  return id;
}

export function atlasVisibleIds(session: Diagnosis, expanded: Set<string>, selected: string | null): Set<string> {
  const nodes = flatten(session.knowledge_tree);
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  const add = (parent: string, child: string) => {
    if (!children.has(parent)) children.set(parent, new Set());
    if (!parents.has(child)) parents.set(child, new Set());
    children.get(parent)!.add(child); parents.get(child)!.add(parent);
  };
  for (const node of nodes) for (const child of node.child_nodes) add(node.concept_id, child.concept_id);
  for (const edge of session.concept_edges ?? []) if (edge.relation === 'part') add(edge.source, edge.target);
  const opened = new Set([...expanded].map(id => redirectedId(session, id)!));
  // Every node created by the conversation should reveal any children that
  // arrive later. Also open its full path when an ancestor was folded away.
  const chatOpened = [...(session.chat?.opened_concept_ids ?? []),
    ...(session.chat?.created_concept_ids ?? [])].map(id => redirectedId(session, id)!);
  for (const id of chatOpened) opened.add(id);
  const ancestors = [...chatOpened, ...(selected ? [selected] : [])];
  const seen = new Set<string>();
  for (let i = 0; i < ancestors.length; i++) {
    const id = redirectedId(session, ancestors[i])!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of parents.get(id) ?? []) { opened.add(parent); ancestors.push(parent); }
  }
  const root = session.knowledge_tree.concept_id;
  const visible = new Set<string>([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const survey = session.self_assessments?.[id];
    const assessed = (session.learning_states[id]?.questions_answered ?? 0) > 0 || (!!survey && survey.level !== 'unsure');
    if (id !== root && !opened.has(id) && !assessed) continue;
    for (const child of children.get(id) ?? []) if (!visible.has(child)) { visible.add(child); queue.push(child); }
  }
  return visible;
}
