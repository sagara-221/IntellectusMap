import {useEffect, useRef, useState} from 'react';
import {forceSimulation, forceLink, forceManyBody, forceCollide, forceRadial, forceX, forceY, type SimulationNodeDatum} from 'd3-force';
export type MapPoint={id:string;x:number;y:number};
export type MapLink={source:string;target:string};
export function hopDistances(ids:string[],links:MapLink[],root:string){
  const adjacency=new Map(ids.map(id=>[id,[] as string[]]));
  for(const e of links){adjacency.get(e.source)?.push(e.target);adjacency.get(e.target)?.push(e.source);}
  const distances=new Map<string,number>([[root,0]]),queue=[root];
  for(let i=0;i<queue.length;i++)for(const next of adjacency.get(queue[i])??[]){
    if(!distances.has(next)){distances.set(next,distances.get(queue[i])!+1);queue.push(next);}
  }
  return distances;
}
type Datum=MapPoint&SimulationNodeDatum;
const mapCenter={x:500,y:350};
const goldenAngle=2.399;

// Place each new child beyond its source node. Keep known positions so revealing
// another branch does not jump the already visible parts of the map.
export function outwardMapPoints(ids:string[],links:MapLink[],root:string,known:ReadonlyMap<string,MapPoint>=new Map()){
  const idSet=new Set(ids),children=new Map<string,string[]>(),parent=new Map<string,string>();
  for(const link of links){
    if(!idSet.has(link.source)||!idSet.has(link.target))continue;
    if(!parent.has(link.target))parent.set(link.target,link.source);
    const siblings=children.get(link.source)??[];
    if(!siblings.includes(link.target))siblings.push(link.target);
    children.set(link.source,siblings);
  }
  const placed=new Map<string,MapPoint>(),visiting=new Set<string>();
  const place=(id:string):MapPoint=>{
    const previous=placed.get(id)??known.get(id);
    if(previous){placed.set(id,previous);return previous;}
    if(id===root){placed.set(id,{id,...mapCenter});return placed.get(id)!;}
    const source=parent.get(id),index=ids.indexOf(id);
    if(!source||visiting.has(id)){
      const angle=index*goldenAngle,point={id,x:mapCenter.x+185*Math.cos(angle),y:mapCenter.y+185*Math.sin(angle)};
      placed.set(id,point);return point;
    }
    visiting.add(id);
    const origin=place(source),rootPoint=place(root);
    visiting.delete(id);
    const siblingIndex=children.get(source)?.indexOf(id)??0;
    const angle=source===root?siblingIndex*goldenAngle:
      Math.atan2(origin.y-rootPoint.y,origin.x-rootPoint.x)+
      Math.max(-1.05,Math.min(1.05,(siblingIndex%2===0?-1:1)*Math.ceil(siblingIndex/2)*.42));
    const step=ids.length>20?200:180;
    const point={id,x:origin.x+step*Math.cos(angle),y:origin.y+step*Math.sin(angle)};
    placed.set(id,point);return point;
  };
  return ids.map(place);
}

function outwardDepths(ids:string[],links:MapLink[],root:string){
  const parent=new Map<string,string>();
  for(const link of links)if(!parent.has(link.target))parent.set(link.target,link.source);
  const depths=new Map<string,number>([[root,0]]),visiting=new Set<string>();
  const depth=(id:string):number=>{
    if(depths.has(id))return depths.get(id)!;
    if(visiting.has(id))return 1;
    visiting.add(id);
    const source=parent.get(id),result=source?depth(source)+1:1;
    visiting.delete(id);
    depths.set(id,result);return result;
  };
  ids.forEach(depth);
  return depths;
}

export function useMapForces(initial:MapPoint[],links:MapLink[],layoutRevision=0,root?:string){
  const [points,setPoints]=useState(initial);
  const previousLayout=useRef(layoutRevision);
  const positions=useRef(new Map(initial.map(p=>[p.id,p])));
  const sim=useRef<ReturnType<typeof forceSimulation<Datum>>|null>(null);
  const [settled,setSettled]=useState(false);
  const topology=initial.map(p=>p.id).join('|')+links.map(l=>l.source+':'+l.target).join('|');
  useEffect(()=>{
    if(previousLayout.current!==layoutRevision){positions.current.clear();previousLayout.current=layoutRevision;}
    const dense=initial.length>20;
    setSettled(false);
    const starts=root?outwardMapPoints(initial.map(p=>p.id),links,root,positions.current):
      initial.map(p=>({...p,...positions.current.get(p.id)}));
    const data=starts.map(p=>({...p}));
    const depths=root?outwardDepths(initial.map(p=>p.id),links,root):null;
    const simulation=forceSimulation<Datum>(data).alphaDecay(.055)
      .force('link',forceLink<Datum,MapLink>(links.map(l=>({...l}))).id(d=>d.id).distance(dense?200:180).strength(.45))
      .force('charge',forceManyBody().strength(dense?-850:-650))
      .force('collision',forceCollide(dense?70:78))
      .force('x',forceX<Datum>(d=>root&&d.id===root?mapCenter.x:480).strength(d=>root&&d.id===root?.8:dense?.008:.025))
      .force('y',forceY<Datum>(d=>root&&d.id===root?mapCenter.y:360).strength(d=>root&&d.id===root?.8:dense?.012:.045))
      .force('radial',root?forceRadial<Datum>(d=>(depths?.get(d.id)??1)*(dense?200:180),mapCenter.x,mapCenter.y).strength(d=>d.id===root?.8:.16):null)
      .on('tick',()=>{const next=data.map(d=>({id:d.id,x:d.x,y:d.y}));positions.current=new Map(next.map(p=>[p.id,p]));setPoints(next);})
      .on('end',()=>setSettled(true));
    sim.current=simulation;
    return ()=>{simulation.stop();};
  },[topology,layoutRevision]);
  function move(id:string,x:number,y:number,end=false){
    const d=sim.current?.nodes().find(n=>n.id===id);if(!d)return;
    if(!end)setSettled(false);
    d.fx=end?null:x;d.fy=end?null:y;
    sim.current?.alphaTarget(end?0:.18).restart();
  }
  return {points,move,settled};
}

// BFS is exact on the graph. IDW interpolates those hop values into screen space;
// an outward extension beyond the graph makes a readable terrain boundary.
// Marching triangles yields contour segments of that interpolated field.
export function contourPaths(points:MapPoint[],links:MapLink[],root='base',bounds?:{left:number;top:number;width:number;height:number}){
  const hops=hopDistances(points.map(p=>p.id),links,root);
  const reachable=points.filter(p=>hops.has(p.id));
  if(!reachable.length)return [];
  const extent=Math.max(1,Math.sqrt(points.length/6)*.85);
  const cols=51,rows=36, left=bounds?.left??500-500*extent,top=bounds?.top??350-350*extent;
  const stepX=bounds?bounds.width/(cols-1):20*extent,stepY=bounds?bounds.height/(rows-1):20*extent;
  const field=Array.from({length:rows},(_,j)=>Array.from({length:cols},(_,i)=>{
    let sum=0,weights=0,nearest=Infinity;
    for(const p of reachable){const distance=Math.hypot(left+i*stepX-p.x,top+j*stepY-p.y);nearest=Math.min(nearest,distance);const w=1/Math.max(1,distance)**4;sum+=hops.get(p.id)!*w;weights+=w;}
    return sum/weights+Math.max(0,nearest-45)/170;
  }));
  return Array.from({length:Math.max(6,Math.ceil(Math.max(...hops.values())*2)+2)},(_,i)=>(i+1)/2).map(level=>{
    let d='';
    for(let j=0;j<rows-1;j++)for(let i=0;i<cols-1;i++){
      const corners=[[left+i*stepX,top+j*stepY,field[j][i]],[left+(i+1)*stepX,top+j*stepY,field[j][i+1]],[left+(i+1)*stepX,top+(j+1)*stepY,field[j+1][i+1]],[left+i*stepX,top+(j+1)*stepY,field[j+1][i]]];
      for(const tri of [[0,1,2],[0,2,3]]){
        const crossings:number[][]=[];
        for(let k=0;k<3;k++){
          const a=corners[tri[k]],b=corners[tri[(k+1)%3]];
          if((a[2]<level)===(b[2]<level))continue;
          const t=(level-a[2])/(b[2]-a[2]);crossings.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);
        }
        if(crossings.length===2)d+=`M${crossings[0][0].toFixed(1)},${crossings[0][1].toFixed(1)}L${crossings[1][0].toFixed(1)},${crossings[1][1].toFixed(1)}`;
      }
    }
    return {level,d};
  });
}
