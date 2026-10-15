import {flatten,visibleConceptIds,type Diagnosis} from './types';
import type {MapLink} from './map-geometry';
import type {SiteAssessment} from './UnderstandingSite';

export function liveMapData(session:Diagnosis,visible=visibleConceptIds(session)){
  const nodes=[...new Map(flatten(session.knowledge_tree).filter(n=>visible.has(n.concept_id)).map(n=>[n.concept_id,n])).values()];
  const links=new Map<string,MapLink>();
  const add=(source:string,target:string)=>{if(visible.has(source)&&visible.has(target)&&source!==target)links.set(`${source}:${target}`,{source,target});};
  nodes.forEach(n=>n.child_nodes.forEach(child=>add(n.concept_id,child.concept_id)));
  session.concept_edges?.filter(e=>e.relation==='part').forEach(e=>add(e.source,e.target));
  const assessments=new Map<string,SiteAssessment>(nodes.map(node=>{
    const summary=session.understanding_summaries?.[node.concept_id];
    // Unknown aggregates must remain unknown, even if a partial score exists.
    return [node.concept_id,{score:summary?.level&&summary.level!=='unknown'?summary.score:null,
      sources:summary?.evidence_sources??(summary?.source==='mixed'?['question','conversation']:summary?.source==='question'||summary?.source==='conversation'||summary?.source==='self_report'?[summary.source]:[]),
      provisional:summary?.provisional,
      confidence:summary?.confidence_level&&summary.confidence_level!=='unknown'?summary.confidence_score:null}];
  }));
  return {nodes,links:[...links.values()],assessments};
}
