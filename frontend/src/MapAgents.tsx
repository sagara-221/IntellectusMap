import PixelRecorder from './PixelRecorder';
import AgentTaskIcon from './AgentTaskIcon';
import {useLayoutEffect,useRef,useState} from 'react';
import Miner from './PixelAgent';
import {agentAction,agentTool,type Job} from './map-crew';
import type {MapPoint} from './map-geometry';

function FieldAgent({job,point,lane}:{job:Job;point:MapPoint;lane:number}){
  const action=agentAction(job);
  const ref=useRef<HTMLDivElement>(null);
  const [departure,setDeparture]=useState({x:0,y:0});
  useLayoutEffect(()=>{
    const world=ref.current?.closest('.map-world');
    const camp=ref.current?.closest('.atlas-map')?.querySelector(`[data-crew="${job.id.split('-')[0]}"]`);
    if(!world||!camp)return;
    const map=world.getBoundingClientRect(),start=camp.getBoundingClientRect();
    // Capture the departure in map coordinates once. Camera changes then move
    // the whole route, agent and destination together, including mobile scale.
    setDeparture({x:(start.left+start.width/2-map.left)*1000/map.width,
      y:(start.top+start.height/2-map.top)*700/map.height});
  },[job.id,job.target]);
  // Stay beside the building, rather than below its name/status labels.
  // Only workers sharing this node need separate positions.
  const positions=[[22,-32],[-58,-32],[0,8],[-18,-68]];
  // Additional workers occupy new rows above the building instead of
  // wrapping back onto the first four workers.
  const extra=lane-positions.length;
  const [dx,dy]=positions[lane]??[-90+(extra%4)*48,-116-Math.floor(extra/4)*48];
  const x=point.x+dx,y=point.y+dy;
  return <div ref={ref} data-agent={job.id} data-target={job.target??undefined} data-display-target={point.id} data-action={action} className={`field-agent ${job.state} task-${action} ${job.target!==point.id?'remote-task':''}`}
    style={{left:x,top:y,'--departure-x':`${departure.x-x}px`,'--departure-y':`${departure.y-y}px`} as React.CSSProperties}>
    <span className="miner-bubble">{job.label}{job.count&&job.count>1?` ×${job.count}`:''} · {job.message}{job.target!==point.id?'（折りたたんだ枝）':''}</span>{job.id.startsWith('recorder')?<PixelRecorder working={job.state==='work'&&action==='write'} planning={job.state==='work'&&action==='plan'}/>:<Miner state={job.state} tint={job.color} tool={action==='prefetch'?'documents':agentTool(job.id.split("-")[0])}/>}
    {job.state==='work'&&<AgentTaskIcon action={action}/>}
  </div>;
}

export default function MapAgents({jobs,points}:{jobs:Job[];points:MapPoint[]}){
  return <div className="agent-overlay" aria-hidden="true">{jobs.map((job,index)=>{
    const point=points.find(p=>p.id===job.displayTarget);
    const lane=jobs.slice(0,index).filter(other=>other.displayTarget===job.displayTarget&&!other.stationed&&other.state!=='idle').length;
    return !job.stationed&&job.state!=='idle'&&point?<FieldAgent key={job.id} job={job} point={point} lane={lane}/>:null;
  })}</div>;
}
