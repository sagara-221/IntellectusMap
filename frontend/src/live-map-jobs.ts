import {useEffect,useState} from 'react';
import {crew,type Job} from './map-crew';
import type {Diagnosis} from './types';
import type {AgentProgress} from './api';

export type MapActivity={role:string;target:string|null;message:string}|null;
export function decompositionMessage(source:string):string {
  const messages:Record<string,string>={
    prefetch:'先読み中（次の層の候補）',
    initial_map:'初期マップの主要項目を生成中',
    decomposition:'下位項目の構成を生成中',
    addition:'指定された項目を追加中',
    chat_addition:'会話から項目を追加中',
    divergence:'関連テーマの展開候補を生成中',
  };
  return messages[source]??'知識項目を処理中';
}
export function progressActivity(progress:AgentProgress):MapActivity {
  if (['ready','complete','completed','failed','idle'].includes(progress.stage)) return null;
  const roles:Record<string,string>={DecompositionAgent:'miner',QuestionAgent:'question',EvaluationAgent:'evaluation',ConceptDeduplicator:'merge',CrossMapAgent:'merge'};
  const role=roles[progress.agent];
  return role?{role,target:progress.concept_id??null,message:progress.message}:null;
}
export function recorderMessage(source:string):string{
  if(source==='chat_extract')return '発言から根拠を抽出中';
  if(source==='chat_structure_review')return '配置案を検証中';
  return '根拠の配置先を照合中';
}
export function groupRecorderJobs(jobs:Job[]):Job[]{
  // Separate evidence batches run in parallel, but share one map marker when
  // their role, destination and task stage are the same.
  const groups=new Map<string,Job[]>();
  for(const job of jobs)if(job.id.startsWith('recorder-')&&job.target&&!job.stationed){
    const key=`${job.source}:${job.target}`;
    groups.set(key,[...(groups.get(key)??[]),job]);
  }
  return jobs.flatMap(job=>{
    if(!job.id.startsWith('recorder-')||!job.target||job.stationed)return [job];
    const group=groups.get(`${job.source}:${job.target}`)!;
    if(group.length===1)return [job];
    return group[0]===job?[{...job,id:`recorder-${job.source}-${job.target}`,count:group.length}]:[];
  });
}
export function useLiveMapJobs(session:Diagnosis,activities:NonNullable<MapActivity>[]){
  const root=session.knowledge_tree.concept_id;
  const generating=Object.entries(session.decomposition_statuses??{}).filter(([,status])=>status==='generating').map(([id])=>id);
  const jobs=crew.map(job=>{
    let target:string|null=null,message='キャンプで待機';
    if(job.id==='merge'&&(session.cross_map_active_count??(session.cross_map_matching?1:0))>0){target=root;message='他のマップの知識と照合中';}
    const activity=activities.find(a=>a.role===job.id);
    if(activity && !(job.id==='question' && (session.next_question?.concept_id===activity.target || session.paused_concept_ids?.includes(activity.target??'')))){target=activity.target??session.active_concept_id??root;message=activity.message;}
    if(job.id==='evaluation' && session.chat?.background_status==='running' && !target){target=session.chat.focus_concept_id??root;message='会話の根拠を地図へ反映中';}
    return {...job,target,message};
  });
  const targets=new Map(generating.map(id=>[id,'下位項目をバックグラウンドで分解中']));
  if(!session.initial_generation_complete&&!targets.size)targets.set(root,'初期マップを生成中');
  for(const activity of activities)if(activity.role==='miner')targets.set(activity.target??session.active_concept_id??root,activity.message);
  // Preserve the three other role slots and give each pending branch its own worker.
  // Queued branches do not dispatch a worker until processing starts.
  const miners:Job[]=targets.size?[...targets].map(([target,message])=>({
    ...crew[0],id:`miner-${target}`,target,message,
  })):[{...crew[0]}];
  const mergeExtras=Array.from({length:Math.max(0,(session.cross_map_active_count??0)-1)},(_,i)=>({
    ...jobs[3],id:`merge-${i+2}`,
  }));
  const allJobs:Job[]=session.agent_runtime ? session.agent_runtime.jobs.filter(j=>j.status==='running').map(j=>({
    ...crew.find(role=>role.id===j.role)!,id:`${j.role}-${j.job_id}`,
    // Recording can start before the conversation has a focused concept.
    // Show that map-wide work beside the root instead of leaving its worker
    // inside the camp, where it is easy to miss among the idle crew.
    target:j.concept_id??(j.role==='recorder'?root:null),source:j.source,
    stationed:j.role==='reception'||(!j.concept_id&&j.role!=='recorder'),
    message:j.role==='reception'?'会話の返答を準備中':j.role==='recorder'?recorderMessage(j.source):j.role==='miner'?decompositionMessage(j.source):j.role==='question'?'問題を生成中':j.role==='evaluation'?(j.source==='answer'?'回答を採点中':'理解の根拠を確認中'):'知識を照合中',
  })) : [miners[0],...jobs.slice(1),...miners.slice(1),...mergeExtras];
  const shownJobs=groupRecorderJobs(allJobs);
  const signature=JSON.stringify(shownJobs.filter(job=>job.target&&!job.stationed).map(job=>`${job.id}:${job.target}`));
  const [arrived,setArrived]=useState<Set<string>>(()=>new Set());
  useEffect(()=>{
    const current:string[]=JSON.parse(signature);
    setArrived(old=>new Set(current.filter(key=>old.has(key))));
    const timer=setTimeout(()=>setArrived(new Set(current)),1000);
    return ()=>clearTimeout(timer);
  },[signature]);
  // Travel is decorative; only API/server state ends a job, never a timer.
  return shownJobs.map(job=>({...job,state:job.stationed?'work':!job.target?'idle':arrived.has(`${job.id}:${job.target}`)?'work':'walk'} as Job));
}
