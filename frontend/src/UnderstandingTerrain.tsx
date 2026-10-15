import {useMemo} from 'react';
import PixelTown from './PixelTown';
import type {MapPoint} from './map-geometry';

export type TerrainPoint=MapPoint&{score:number|null};
type Vertex={x:number;y:number};

// Trace the outside of a sampled region, removing every internal cell edge.
// Quadratic corners turn the shared field into connected cartographic landforms.
function outline(cells:boolean[][],left:number,top:number,step:number){
  const edges=new Map<string,Vertex[]>();
  const add=(a:Vertex,b:Vertex)=>{const key=`${a.x},${a.y}`;edges.set(key,[...(edges.get(key)??[]),b]);};
  const has=(x:number,y:number)=>cells[y]?.[x]??false;
  cells.forEach((row,y)=>row.forEach((on,x)=>{if(!on)return;
    if(!has(x,y-1))add({x,y},{x:x+1,y});
    if(!has(x+1,y))add({x:x+1,y},{x:x+1,y:y+1});
    if(!has(x,y+1))add({x:x+1,y:y+1},{x,y:y+1});
    if(!has(x-1,y))add({x,y:y+1},{x,y});
  }));
  let path='';
  while(edges.size){
    const key=edges.keys().next().value!;
    const [x,y]=key.split(',').map(Number),start={x,y},loop:Vertex[]=[];
    let current=start;
    do{
      loop.push({x:left+current.x*step,y:top+current.y*step});
      const k=`${current.x},${current.y}`,next=edges.get(k);if(!next?.length)break;
      current=next.pop()!;if(!next.length)edges.delete(k);
    }while(current.x!==start.x||current.y!==start.y);
    if(loop.length<6)continue;
    // Simplify grid steps before rounding to avoid a staircase coastline.
    let smooth=loop.filter((_,i)=>i%3===0);
    for(let pass=0;pass<3;pass++)smooth=smooth.flatMap((a,i)=>{const b=smooth[(i+1)%smooth.length];return [{x:a.x*.75+b.x*.25,y:a.y*.75+b.y*.25},{x:a.x*.25+b.x*.75,y:a.y*.25+b.y*.75}];});
    path+='M'+smooth.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')+'Z';
  }
  return path;
}
export default function UnderstandingTerrain({points,zoom}:{points:TerrainPoint[];zoom:number}){
  const regions=useMemo(()=>{
    if(!points.length)return ['','','',''];
    const step=32;
    const left=Math.floor((Math.min(...points.map(p=>p.x))-240)/step)*step;
    const top=Math.floor((Math.min(...points.map(p=>p.y))-240)/step)*step;
    const cols=Math.ceil((Math.max(...points.map(p=>p.x))+240-left)/step);
    const rows=Math.ceil((Math.max(...points.map(p=>p.y))+240-top)/step);
    const fields=Array.from({length:4},()=>Array.from({length:rows},()=>Array<boolean>(cols).fill(false)));
    const levels=points.map(p=>p.score===null?0:p.score<.4?1:p.score<.8?2:3);
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
      const wx=left+(x+.5)*step,wy=top+(y+.5)*step;
      const weights=[0,0,0,0];let nearest=Infinity,closest=0;
      points.forEach((p,i)=>{const d=(p.x-wx)**2+(p.y-wy)**2;if(d<nearest){nearest=d;closest=levels[i];}weights[levels[i]]+=Math.exp(-d/(2*105**2));});
      if(nearest>205**2)continue;
      fields[0][y][x]=true;
      const total=weights.reduce((a,b)=>a+b,0);
      const dominant=nearest<65**2?closest:weights.indexOf(Math.max(...weights));
      // Keep a sandy transition strip, rather than a hard cell boundary.
      if(nearest<65**2||weights[dominant]/total>.48){
        if(dominant===3)fields[1][y][x]=true;
        if(dominant===1)fields[2][y][x]=true;
        if(dominant===0)fields[3][y][x]=true;
      }
    }
    return fields.map(field=>outline(field,left,top,step));
  },[points]);
  const unit=1/Math.max(.3,zoom),spacing=32*unit;
  return <svg className="understanding-terrain" viewBox="0 0 1000 700" aria-hidden="true">
    <defs>
      <pattern id="terrain-hills" width={spacing} height={spacing*.8} patternUnits="userSpaceOnUse"><path d={`M${5*unit},${17*unit}q${7*unit},${-13*unit} ${14*unit},0m${-9*unit},${-2*unit}q${7*unit},${-11*unit} ${14*unit},0`} fill="none" stroke="#9c8563" strokeWidth={.85*unit} opacity=".65"/></pattern>
      <pattern id="terrain-unexplored" width={spacing*2} height={spacing*1.5} patternUnits="userSpaceOnUse"><g transform={`scale(${unit})`} fill="none" stroke="#c5c1b5" strokeWidth=".9" opacity=".65"><path d="M8 19q5-5 10 0t10 0M33 36q5-5 10 0t10 0"/></g></pattern>
    </defs>
    <path d={regions[0]} fill="none" stroke="#a5beb4" strokeWidth="7" strokeOpacity=".2" vectorEffect="non-scaling-stroke"/>
    <path d={regions[0]} fill="#eee7d2" stroke="#a5ae91" strokeWidth="1" vectorEffect="non-scaling-stroke"/>
    {regions.slice(1).map((d,i)=><g key={i} data-terrain-level={i}>
      <path d={d} fill={['#dce2c8','#e2d2b2','#faf8f0'][i]} stroke={['#adba95','#b9a17d','#b8b2a2'][i]} strokeWidth={.8} strokeDasharray={i===2?'3 7':undefined} vectorEffect="non-scaling-stroke"/>
      {i>0&&<path d={d} fill={`url(#terrain-${i===1?'hills':'unexplored'})`}/>}
    </g>)}
    {points.filter(p=>p.score!==null&&p.score>=.8).map(p=>{
      const nearest=Math.min(...points.filter(other=>other.id!==p.id).map(other=>Math.hypot(p.x-other.x,p.y-other.y)));
      const smallMap=points.length<=8;
      const scale=smallMap?Math.min(1.5,nearest/130):Math.min(1.3,Math.max(.65,.6/zoom),nearest/155);
      return <g key={p.id} data-town={p.id} transform={`translate(${p.x} ${p.y-(smallMap?22:0)}) scale(${scale})`}><PixelTown/></g>;
    })}
  </svg>;
}
