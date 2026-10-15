import {flatten,type Diagnosis} from './types';
import type {MapPoint} from './map-geometry';
import type {Job} from './map-crew';

export function placeAgentJobs(jobs:Job[],session:Diagnosis,points:MapPoint[]):Job[]{
  const visible=new Set(points.map(point=>point.id));
  const names=new Map(flatten(session.knowledge_tree).map(node=>[node.concept_id,node.concept_name]));
  const parents=new Map<string,Set<string>>();
  const addParent=(child:string,parent:string)=>{
    if(!parents.has(child))parents.set(child,new Set());
    parents.get(child)!.add(parent);
  };
  for(const node of flatten(session.knowledge_tree)){
    for(const child of node.child_nodes)addParent(child.concept_id,node.concept_id);
    for(const parent of node.parent_ids??[])addParent(node.concept_id,parent);
    if(node.parent_concept_id)addParent(node.concept_id,node.parent_concept_id);
  }
  for(const edge of session.concept_edges??[])if(edge.relation==='part')addParent(edge.target,edge.source);
  const nearestVisible=(target:string|null)=>{
    if(!target)return null;
    const queue=[target],seen=new Set<string>();
    for(let index=0;index<queue.length;index++){
      const current=queue[index];
      if(seen.has(current))continue;
      seen.add(current);
      if(visible.has(current))return current;
      queue.push(...(parents.get(current)??[]));
    }
    return null;
  };
  return jobs.map(job=>{
    const displayTarget=nearestVisible(job.target);
    return {...job,targetName:job.target?names.get(job.target):undefined,displayTarget,stationed:job.stationed||!displayTarget};
  });
}
