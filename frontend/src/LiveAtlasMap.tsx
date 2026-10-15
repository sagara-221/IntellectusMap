import AgentHandoffs from './AgentHandoffs';
import AgentTaskIcon from './AgentTaskIcon';
import PixelRecorder from './PixelRecorder';
import PixelReceptionist from './PixelReceptionist';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Compass,Minus,Plus,Search} from 'lucide-react';
import type {ReactNode} from 'react';
import type {Diagnosis} from './types';
import {liveMapData} from './live-map-data';
import {placeAgentJobs} from './agent-placement';
import {useLiveMapJobs,type MapActivity} from './live-map-jobs';
import {useMapForces,outwardMapPoints,contourPaths,hopDistances} from './map-geometry';
import UnderstandingTerrain from './UnderstandingTerrain';
import UnderstandingSite,{assessmentLabel,siteLevel,siteLevels} from './UnderstandingSite';
import AssessmentSourceIcon from './AssessmentSourceIcon';
import Miner from './PixelAgent';
import MapAgents from './MapAgents';
import {agentAction,agentTool,crew} from './map-crew';
import DecompositionIcon,{preparationLabel,type QuestionReadiness} from './DecompositionIcon';
import PixelNotebook from './PixelNotebook';

type UnderstandingLevel=keyof typeof siteLevels;
const understandingLevels:UnderstandingLevel[]=['high','medium','low','unknown'];

export default function LiveAtlasMap({session,selected,onSelect,activity,visibleIds,notebook,notebookOpen=false,onToggleNotebook,chat,chatOpen=false,onToggleChat}:{session:Diagnosis;selected:string|null;onSelect:(id:string)=>void;activity:NonNullable<MapActivity>[];visibleIds?:Set<string>;notebook?:ReactNode;chat?:ReactNode;chatOpen?:boolean;onToggleChat?:()=>void;notebookOpen?:boolean;onToggleNotebook?:()=>void}){
  const data=useMemo(()=>liveMapData(session,visibleIds),[session,visibleIds]);
  const {nodes,links,assessments}=data;
  const root=session.knowledge_tree.concept_id;
  const initial=useMemo(()=>outwardMapPoints(nodes.map(n=>n.concept_id),links,root),[nodes.map(n=>n.concept_id).join('|'),links.map(l=>`${l.source}:${l.target}`).join('|'),root]);
  const [layoutRevision,setLayoutRevision]=useState(0);
  const {points,move,settled}=useMapForces(initial,links,layoutRevision,root);
  const [zoom,setZoom]=useState(1),[offset,setOffset]=useState({x:0,y:0});
  const [search,setSearch]=useState(''),[terrain,setTerrain]=useState(true);
  const [shownLevels,setShownLevels]=useState<Set<UnderstandingLevel>>(()=>new Set(understandingLevels));
  const [reduced,setReduced]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  const world=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null);
  const camera=useRef({zoom,offset});camera.current={zoom,offset};
  const manualCamera=useRef(false),fitCount=useRef(0);
  const revealedByChat=useRef(new Set<string>());
  const drag=useRef<{id?:string;x:number;y:number;ox:number;oy:number;moved:boolean}|null>(null);
  const byId=new Map(points.map(p=>[p.id,p]));
  const neighbors=new Set([selected,...links.filter(l=>l.source===selected||l.target===selected).flatMap(l=>[l.source,l.target])]);
  const parents=new Map(nodes.map(n=>[n.concept_id,links.filter(l=>l.target===n.concept_id).map(l=>l.source)]));
  const query=search.trim().toLocaleLowerCase();
  const matches=nodes.filter(n=>`${n.concept_name} ${n.description}`.toLocaleLowerCase().includes(query));
  const matchIds=new Set(matches.map(n=>n.concept_id));
  const overview=nodes.length>6&&zoom<.85;
  const hops=useMemo(()=>hopDistances(nodes.map(n=>n.concept_id),links,root),[nodes,links,root]);
  const contours=useMemo(()=>contourPaths(points,links,root),[points,links,root]);
  const terrainPoints=useMemo(()=>points.map(p=>({...p,score:assessments.get(p.id)?.score??null})),[points,assessments]);
  const jobs=useLiveMapJobs(session,activity);
  const placedJobs=placeAgentJobs(jobs,session,points);
  const active=placedJobs.filter(job=>job.state!=='idle');
  const campActive=active.filter(job=>!job.id.startsWith('reception')).reduce((total,job)=>total+(job.count??1),0);
  const receptionWorking=!!session.agent_runtime?.counts.reception?.running;
  const questionReady=new Set([
    ...session.paused_concept_ids,
    ...(session.next_question?[session.next_question.concept_id]:[]),
  ]);
  function setCamera(z:number,o=offset){camera.current={zoom:z,offset:o};setZoom(z);setOffset(o);}
  function fit(){
    if(!surface.current||!world.current||!points.length)return;
    const outer=Number.parseFloat(getComputedStyle(world.current).scale)||1;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const minX=Math.min(...xs)-100,maxX=Math.max(...xs)+100,minY=Math.min(...ys)-120,maxY=Math.max(...ys)+100;
    const z=Math.max(.15,Math.min(1.2,(surface.current.clientWidth-40)/((maxX-minX)*outer),(surface.current.clientHeight-110)/((maxY-minY)*outer)));
    setCamera(z,{x:(500-(minX+maxX)/2)*z,y:(350-(minY+maxY)/2)*z+20/outer});
  }
  const chatRevealIds=[...(session.chat?.created_concept_ids??[]).map(id=>`created:${id}`),
    ...(session.chat?.opened_concept_ids??[]).map(id=>`opened:${id}`)];
  const chatRevealKey=chatRevealIds.join('|');
  useEffect(()=>{
    const next=new Set(chatRevealIds);
    if([...next].some(id=>!revealedByChat.current.has(id))){
      // A newly revealed branch should enter the viewport even after a manual pan.
      manualCamera.current=false;
      fitCount.current=0;
    }
    revealedByChat.current=next;
  },[chatRevealKey]);
  useEffect(()=>{if(settled&&!manualCamera.current&&fitCount.current!==nodes.length){fitCount.current=nodes.length;fit();}},[settled,nodes.length,chatRevealKey]);
  useEffect(()=>{
    const el=surface.current;if(!el)return;
    const wheel=(e:WheelEvent)=>{
      e.preventDefault();manualCamera.current=true;
      const map=world.current!,rect=map.getBoundingClientRect(),style=getComputedStyle(map);
      const origin=style.transformOrigin.split(' ').map(parseFloat),outer=parseFloat(style.scale)||1;
      const current=camera.current,delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?el.clientHeight:1);
      const z=Math.max(.15,Math.min(3,current.zoom*Math.exp(-Math.max(-150,Math.min(150,delta))*.002)));
      const ratio=z/current.zoom;
      const o={x:current.offset.x+(1-ratio)*(e.clientX-rect.left-origin[0]*rect.width/1000)/outer,
        y:current.offset.y+(1-ratio)*(e.clientY-rect.top-origin[1]*rect.height/700)/outer};
      setCamera(z,o);
    };
    el.addEventListener('wheel',wheel,{passive:false});return ()=>el.removeEventListener('wheel',wheel);
  },[]);
  function coordinates(e:React.PointerEvent){const r=world.current!.getBoundingClientRect();return {x:(e.clientX-r.left)*1000/r.width,y:(e.clientY-r.top)*700/r.height};}
  function focus(id:string){const point=byId.get(id);if(point){manualCamera.current=true;setCamera(1.2,{x:(500-point.x)*1.2,y:(350-point.y)*1.2});}onSelect(id);setSearch('');}
  return <div className={`atlas live-map ${nodes.length>6?'dense-map':''} ${overview?'overview-map':'detail-map'} ${reduced?'reduced':''} ${notebookOpen||chatOpen?'journal-open':''} ${chatOpen?'chat-open':''}`}  style={{'--map-scale':zoom} as React.CSSProperties}>
    <div className="live-map-tools">
      <label className="live-search"><Search size={14}/><input aria-label="知識項目を検索" placeholder="知識を検索…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <button disabled={!settled} onClick={()=>{manualCamera.current=false;fitCount.current=0;setLayoutRevision(n=>n+1);}}>配置を整える</button>
      <fieldset className="understanding-filters" aria-label="理解度で強調表示"><legend>理解度</legend>{understandingLevels.map(level=><label key={level}><input type="checkbox" aria-label={`${siteLevels[level].label}を強調表示`} checked={shownLevels.has(level)} onChange={e=>setShownLevels(current=>{const next=new Set(current);if(e.target.checked)next.add(level);else next.delete(level);return next;})}/><i className={`filter-dot level-${level}`}/>{siteLevels[level].label}</label>)}</fieldset>
      <label><input type="checkbox" checked={terrain} onChange={e=>setTerrain(e.target.checked)}/>理解度エリア</label>
      <label><input type="checkbox" checked={reduced} onChange={e=>setReduced(e.target.checked)}/>動きを抑える</label>
    </div>
    {query&&<div className="live-search-results">{matches.length?matches.slice(0,20).map(n=><button key={n.concept_id} onClick={()=>focus(n.concept_id)}>{n.concept_name}</button>):<p>該当する項目がありません。</p>}</div>}
    <div className="atlas-map" data-layout={settled?'settled':'moving'}>
      <div ref={surface} className="map-surface" onPointerDown={e=>{if((e.target as HTMLElement).closest('button'))return;manualCamera.current=true;drag.current={x:e.clientX,y:e.clientY,ox:offset.x,oy:offset.y,moved:false};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{const d=drag.current;if(!d)return;d.moved ||= Math.hypot(e.clientX-d.x,e.clientY-d.y)>4;if(d.id){const p=coordinates(e);move(d.id,p.x,p.y);}else{const outer=parseFloat(getComputedStyle(world.current!).scale)||1;setCamera(zoom,{x:d.ox+(e.clientX-d.x)/outer,y:d.oy+(e.clientY-d.y)/outer});}}}
        onPointerUp={e=>{const d=drag.current;if(d?.id){const p=coordinates(e);move(d.id,p.x,p.y,true);if(!d.moved)onSelect(d.id);}drag.current=null;}}
        onPointerCancel={()=>{if(drag.current?.id)move(drag.current.id,0,0,true);drag.current=null;}}>
        <div ref={world} className="map-world" style={{transform:`translate(${offset.x}px,${offset.y}px) scale(${zoom})`,transformOrigin:'500px 350px'}}>
          {terrain&&<UnderstandingTerrain points={terrainPoints} zoom={zoom}/>}
          <svg className="terrain" viewBox="0 0 1000 700" aria-label="テーマからの最短ホップ数の等高線">
            {contours.filter(c=>!overview||c.level%(nodes.length>60?2:1)===0).map(c=><path key={c.level} d={c.d} data-level={c.level} className="distance-contour" fill="none" stroke="#acba98" strokeWidth="1"/>)}
            {links.map(l=>{const a=byId.get(l.source),b=byId.get(l.target);if(!a||!b)return null;const high=(assessments.get(l.source)?.score??-1)>=.8&&(assessments.get(l.target)?.score??-1)>=.8,focused=l.source===selected||l.target===selected;
              const coords={x1:a.x,y1:a.y,x2:b.x,y2:b.y};
              const muted=![l.source,l.target].every(id=>shownLevels.has(siteLevel(assessments.get(id)?.score??null)));
              return <g key={`${l.source}:${l.target}`} opacity={focused?1:muted?.16:overview?.3:.65}>{high&&<line {...coords} className="road-border" vectorEffect="non-scaling-stroke"/>}<line {...coords} data-edge={`${l.source}:${l.target}`} className={`${high?'road-center':''} ${focused?'edge-selected':''}`} stroke="#98a588" strokeWidth="1.3" strokeDasharray={high?undefined:'5 7'} vectorEffect="non-scaling-stroke"/></g>;
            })}
          </svg>
          {nodes.map(n=>{const p=byId.get(n.concept_id);if(!p)return null;const a=assessments.get(n.concept_id)!,shared=(parents.get(n.concept_id)?.length??0)>1;
            const terminal=n.depth>0&&n.terminal_confirmed&&n.child_candidates.length===0&&!n.child_nodes.length&&!session.concept_edges.some(e=>e.relation==='part'&&e.source===n.concept_id);
            const covered=n.assessment_scope==='covered_by_parent';
            const decomposition=session.decomposition_statuses?.[n.concept_id]??(n.depth>0?
              (n.child_nodes.length||session.concept_edges.some(e=>e.relation==='part'&&e.source===n.concept_id)||n.terminal_confirmed?'ready':n.expansion_error?'failed':'available'):undefined);
            const preparedQuestion=session.question_statuses?.[n.concept_id];
            const question:QuestionReadiness=preparedQuestion ? preparedQuestion.status==='available'?'missing':preparedQuestion.status==='cancelled'?'failed':preparedQuestion.status : questionReady.has(n.concept_id)?'ready':activity.some(a=>a.role==='question'&&a.target===n.concept_id)?'generating':'unknown';
            const decompositionLabel=decomposition?preparationLabel(decomposition,question):'';
            const aggregate=session.understanding_summaries?.[n.concept_id]?.source==='descendants';
            const sharedEvidence=session.evidence.some(e=>e.concept_id===n.concept_id&&e.origin_map_id&&e.origin_map_id!==session.session_id);
            const statusText=[decompositionLabel,aggregate?'下位項目から集計した理解度':'',sharedEvidence?'別の地図の回答を反映':'',terminal?'AI判定：分解候補なし（理解済みの意味ではありません）':'',covered?'親の結果により出題省略（この項目は直接評価していません）':''].filter(Boolean).join('。');
            const filtered=!shownLevels.has(siteLevel(a.score));
            const dim=filtered||(query&&!matchIds.has(n.concept_id));
            return <button key={n.concept_id} data-node={n.concept_id} title={`${n.description}\n${assessmentLabel(a)}\n${statusText}`} aria-label={`${n.concept_name}の診断詳細${statusText?`。${statusText}`:""}`} aria-pressed={selected===n.concept_id}
              className={`map-place assessment-node ${selected===n.concept_id?'selected':''} ${shared?'shared-site':''} ${neighbors.has(n.concept_id)?'neighbor-site':'distant-site'} ${n.concept_id===root?'root-site':''} ${dim?'muted-site':''} ${filtered?'filtered-site':''}`}
              style={{left:p.x,top:p.y}} onPointerDown={e=>{e.stopPropagation();drag.current={id:n.concept_id,x:e.clientX,y:e.clientY,ox:0,oy:0,moved:false};e.currentTarget.setPointerCapture(e.pointerId);}}
              onClick={e=>{if(e.detail===0)onSelect(n.concept_id);}}>
              <span className={`overview-dot dot-${siteLevel(a.score)}`} aria-hidden="true"/><UnderstandingSite assessment={a}/>{n.concept_id===root&&<span className="start-landmark" aria-hidden="true"><svg viewBox="0 0 32 32" shapeRendering="crispEdges"><path fill="#496556" d="M14 1h4v4h-4zM14 27h4v4h-4zM1 14h4v4H1zM27 14h4v4h-4z"/><path fill="#d5aa5b" d="m16 5 4 7 7 4-7 4-4 7-4-7-7-4 7-4z"/><path fill="#fff2c7" d="m16 9 2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path fill="#496556" d="M14 14h4v4h-4z"/></svg></span>}{decomposition&&<DecompositionIcon status={decomposition} question={question}/>}<strong>{n.concept_name}</strong>
              {shared&&<span className="junction-tag">結合 · {parents.get(n.concept_id)!.length}親</span>}
              <small>{hops.get(n.concept_id)??'—'} hop · {a.score===null?'未確認':`${Math.round(a.score*100)}%`}</small>
              <span className="node-status-badges">{aggregate&&<span>下位項目の集計</span>}{sharedEvidence&&<span>別の地図の回答を反映</span>}{terminal&&<span className="node-status-terminal">◇ 分解候補なし</span>}{covered&&<span className="node-status-covered">↳ 親の結果で出題省略</span>}</span>
            </button>;
          })}
          <MapAgents jobs={placedJobs} points={points}/>
        </div>
      </div>
      <AgentHandoffs events={session.agent_runtime?.handoffs??[]} reduced={reduced}/>
      <div className="basecamp-dock"><div className="crew-camp"><span className="eyebrow">BASE CAMP</span><strong>調査隊 <small>{campActive} 稼働中</small></strong><div>{crew.filter(role=>role.id!=='reception').map(role=>{
        const members=placedJobs.filter(j=>j.id===role.id||j.id.startsWith(`${role.id}-`));
        const dispatched=members.filter(j=>j.state!=='idle').reduce((total,job)=>total+(job.count??1),0);
        const campWorking=members.filter(j=>j.state!=='idle'&&j.stationed);
        const campAction=campWorking.length?agentAction(campWorking[0]):null;
        const capacity=session.agent_capacities?.[role.id as keyof NonNullable<Diagnosis['agent_capacities']>];
        const waiting=session.agent_runtime?.counts[role.id as keyof NonNullable<Diagnosis['agent_runtime']>['counts']]?.idle??(capacity===undefined?null:Math.max(0,capacity-dispatched));
        const label=waiting===null?`${role.label}：定員を取得中`:`${role.label}：待機 ${waiting}体 / 最大 ${capacity}体（作業中 ${dispatched}体、うち拠点で ${campWorking.length}体）`;
        return <div key={role.id} data-crew={role.id} data-camp-working={campWorking.length} data-action={campAction??undefined} className={`camp-slot ${waiting===0?'empty':'resting'} ${campAction?`station-working task-${campAction}`:''}`} title={label} aria-label={label} role="img">
          {role.id==='recorder'?<PixelRecorder working={campAction==='write'} planning={campAction==='plan'}/>:<Miner state={campAction?'work':'idle'} tint={role.color} tool={campAction==='prefetch'?'documents':agentTool(role.id)}/>}
          {campAction&&<AgentTaskIcon action={campAction}/>}
          {campWorking.length>0&&<i className="camp-work-count" aria-hidden="true">●{campWorking.length}</i>}
          <b className="crew-count" aria-hidden="true">×{waiting??'—'}</b>
        </div>;
      })}</div></div>{notebook&&<><button className="notebook-toggle" type="button" aria-label="調査手帳を開く" aria-expanded={notebookOpen} aria-controls="atlas-notebook" onClick={onToggleNotebook} hidden={notebookOpen||chatOpen}><PixelNotebook/><span aria-hidden="true">調査手帳</span>{session.next_question&&<i className="notebook-alert" aria-hidden="true"/>}</button>{notebook}</>}{chat&&<><button className={`notebook-toggle reception-toggle ${receptionWorking?'reception-talking':''}`} type="button" aria-label="チャットを開く" aria-expanded={chatOpen} aria-controls="atlas-chat" onClick={onToggleChat} hidden={notebookOpen||chatOpen}><span className="reception-avatar" data-reception-anchor><PixelReceptionist/></span><span>探索受付</span></button>{chat}</>}</div>
      <div className="texture-legend"><b>理解度</b><span><i className="area-key area-high"/>町 · 高</span><span><i className="area-key area-medium"/>平地 · 中</span><span><i className="area-key area-low"/>丘陵 · 低</span><span><i className="area-key area-unknown"/>未踏</span><span><AssessmentSourceIcon source="question"/>回答</span><span><AssessmentSourceIcon source="conversation"/>会話</span><span><AssessmentSourceIcon source="conversation" provisional/>暫定</span></div>
      <div className="map-controls"><button onClick={()=>{manualCamera.current=true;setCamera(Math.max(.15,zoom-.15));}} aria-label="縮小"><Minus size={17}/></button><span>{Math.round(zoom*100)}%</span><button onClick={()=>{manualCamera.current=true;setCamera(Math.min(3,zoom+.15));}} aria-label="拡大"><Plus size={17}/></button><button onClick={fit} aria-label="地図の位置を戻す"><Compass size={17}/></button></div>
    </div>
    <div className="live-crew-report" role="status">{active.length?active.map(j=>`${j.label}：${j.message}`).join(' ／ '):'調査隊はキャンプで待機中'}<small>処理状況はAPIの応答と定期取得に連動 · 等高線は最短ホップ距離</small></div>
  </div>;
}
