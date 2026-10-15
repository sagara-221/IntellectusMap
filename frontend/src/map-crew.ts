export type AgentAction='dig'|'prefetch'|'build'|'question'|'grade'|'inspect'|'merge'|'write'|'plan'|'reply';
export function agentTool(role:string):import('./PixelAgent').AgentTool {
  return role==='question'?'pen':role==='evaluation'||role==='survey'?'lens':role==='merge'?'documents':'pick';
}
export type Job={targetName?:string;stationed?:boolean;displayTarget?:string|null;source?:string;count?:number;id:string;label:string;color:string;target:string|null;state:'idle'|'walk'|'work';message:string};
export function agentAction(job:Job):AgentAction {
  const role=job.id.split('-')[0];
  if(role==='miner'&&job.source==='prefetch')return 'prefetch';
  if(role==='miner')return job.source==='addition'||job.source==='chat_addition'?'build':'dig';
  if(role==='question')return 'question';
  if(role==='evaluation')return job.source==='answer'?'grade':'inspect';
  if(role==='merge')return 'merge';
  if(role==='recorder')return job.source==='chat_extract'?'write':'plan';
  return 'reply';
}
export const crew:Job[]=[
  {id:'miner',label:'分解係',color:'#d79539',target:null,state:'idle',message:'キャンプで待機'},
  {id:'question',label:'出題係',color:'#6689b0',target:null,state:'idle',message:'キャンプで待機'},
  {id:'evaluation',label:'評価係',color:'#a77bb3',target:null,state:'idle',message:'キャンプで待機'},
  {id:'merge',label:'統合係',color:'#659780',target:null,state:'idle',message:'キャンプで待機'},
  {id:'reception',label:'受付係',color:'#416c5a',target:null,state:'idle',message:'受付で待機'},
  {id:'recorder',label:'記録係',color:'#aa7655',target:null,state:'idle',message:'キャンプで待機'},
];
