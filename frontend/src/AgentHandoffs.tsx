import {useEffect,useRef,useState} from 'react';
import type {AgentHandoff} from './types';
import {crew} from './map-crew';

const label=(role:string)=>crew.find(item=>item.id===role)?.label??role;
function Transfer({event,reduced,done}:{event:AgentHandoff;reduced:boolean;done:()=>void}){
  const ref=useRef<SVGSVGElement>(null);
  const [frame,setFrame]=useState<{x:number;y:number;path:string;progress:number}|null>(null);
  const finish=useRef(done);finish.current=done;
  useEffect(()=>{
    const svg=ref.current,host=svg?.parentElement;
    if(!svg||!host)return;
    let request=0,start=0;
    const quiet=reduced||matchMedia('(prefers-reduced-motion: reduce)').matches;
    function anchor(role:string,job:string|null){
      const selectors=[...(job?[`[data-agent="${CSS.escape(role+'-'+job)}"]`]:[]),
        ...(role==='reception'?['[data-reception-anchor]']:[`[data-crew="${CSS.escape(role)}"]`]),
        ...(role==='recorder'?['[data-reception-anchor]']:[])];
      for(const selector of selectors){
        for(const element of host!.querySelectorAll<HTMLElement>(selector)){
          if(getComputedStyle(element).visibility==='hidden'||!element.getClientRects().length)continue;
          const r=element.getBoundingClientRect(),h=host!.getBoundingClientRect();
          if(r.width&&r.height)return {x:r.left+r.width/2-h.left,y:r.top+r.height/2-h.top};
        }
      }
      return null;
    }
    function tick(now:number){
      start ||= now;
      const progress=Math.min(1,(now-start)/(quiet?1100:2200));
      const from=anchor(event.from_role,event.from_job_id),to=anchor(event.to_role,event.to_job_id);
      if(from&&to){
        const p=quiet?1:Math.min(1,progress/.8),t=p*p*(3-2*p);
        const cx=(from.x+to.x)/2,cy=Math.max(12,Math.min(from.y,to.y)-45);
        setFrame({x:(1-t)**2*from.x+2*(1-t)*t*cx+t*t*to.x,
          y:(1-t)**2*from.y+2*(1-t)*t*cy+t*t*to.y,
          path:quiet?'':`M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`,progress});
      }
      if(progress<1)request=requestAnimationFrame(tick);else finish.current();
    }
    request=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(request);
  },[event,reduced]);
  return <svg ref={ref} className="agent-handoff" data-handoff={event.event_id} aria-hidden="true">
    {frame&&<><path d={frame.path} fill="none" stroke="#a58953" strokeWidth="1.5" strokeDasharray="3 6" opacity=".65"/>
      <g transform={`translate(${frame.x},${frame.y})`}>
        {frame.progress>.8?<><circle r="13" fill="#fff8df" stroke="#63866c"/><path d="M-5 0l3 4 7-8" stroke="#416c5a" strokeWidth="2" fill="none"/></>:
          <g shapeRendering="crispEdges"><rect x="-10" y="-7" width="20" height="14" rx="1" fill="#fff2c9" stroke="#715a38" strokeWidth="2"/><path d="M-9-6L0 1 9-6" fill="none" stroke="#a87b48" strokeWidth="2"/></g>}
      </g></>}
  </svg>;
}

export default function AgentHandoffs({events,reduced}:{events:AgentHandoff[];reduced:boolean}){
  const seen=useRef<Set<string>|null>(null);
  const [active,setActive]=useState<AgentHandoff[]>([]);
  useEffect(()=>{
    // Saved history is not replayed when reopening a map. Polls may repeat it.
    if(!seen.current){seen.current=new Set(events.map(e=>e.event_id));return;}
    const fresh=events.filter(e=>!seen.current!.has(e.event_id)&&Date.now()/1000-e.created_at<15);
    seen.current=new Set(events.map(e=>e.event_id));
    if(fresh.length)setActive(current=>[...current,...fresh].slice(-6));
  },[events]);
  return <>{active.map(event=><Transfer key={event.event_id} event={event} reduced={reduced}
    done={()=>setActive(current=>current.filter(e=>e.event_id!==event.event_id))}/>)}
    {active.length>0&&<div className="agent-handoff-caption" role="status">{[...new Set(active.map(e=>`${label(e.from_role)} → ${label(e.to_role)}：${e.kind==='result'?'結果を報告':'情報を引き継ぎ'}`))].join(' ／ ')}</div>}
  </>;
}
