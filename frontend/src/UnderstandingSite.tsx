import AssessmentSourceIcon,{assessmentSourceLabels,type AssessmentSource} from './AssessmentSourceIcon';
export type SiteAssessment = {score:number|null;confidence:number|null;sources?:AssessmentSource[];provisional?:boolean};
export const siteLevels = {
  unknown:{label:'未確認',building:'未調査の石碑'},
  low:{label:'低',building:'仮設テント'},
  medium:{label:'中',building:'建設途中の小屋'},
  high:{label:'高',building:'完成した拠点'},
};
export function siteLevel(score:number|null){return score===null?'unknown':score<.4?'low':score<.8?'medium':'high';}
export function assessmentLabel(a:SiteAssessment){
  return `${a.score===null?'理解度は未確認':`推定理解度 ${Math.round(a.score*100)}%、${siteLevels[siteLevel(a.score)].label}`}。確認の確かさ：${a.confidence===null?'未確認':a.confidence>=.7?'十分':'根拠が少ない'}。${(a.sources??[]).map(source=>assessmentSourceLabels[source]).join('・')}${a.provisional?'（暫定・未検証）':''}`;
}
export default function UnderstandingSite({assessment}:{assessment:SiteAssessment}){
  const level=siteLevel(assessment.score);
  const confident=assessment.confidence!==null&&assessment.confidence>=.7;
  return <span className={`understanding-site site-${level}`} data-level={level}>
    {!!assessment.sources?.length&&<span className="assessment-source-badges">{assessment.sources.map(source=><AssessmentSourceIcon key={source} source={source} provisional={assessment.provisional}/>)}</span>}
    <svg className="understanding-ring" viewBox="0 0 80 80" aria-hidden="true">
      <circle className={`ring-track ${level==='unknown'?'unassessed':''}`} cx="40" cy="40" r="34"/>
      {assessment.score!==null&&<circle className="ring-value" cx="40" cy="40" r="34" pathLength="100" strokeDasharray={`${assessment.score*100} 100`} transform="rotate(-90 40 40)"/>}
    </svg>
    <span className="site-ground"><svg viewBox="0 0 32 32" className="site-building" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="#42514333" d="M3 28h26v3H3z"/>
      {level==='unknown'?<><path fill="#89948c" d="M10 7h12v3h2v17H8V10h2z"/><path fill="#c6cbc1" d="M10 9h10v16H10z"/><path fill="#77877e" d="M13 12h5v2h-2v4h-2v-5h-1zM14 20h2v2h-2z"/><path fill="#a9b1a3" d="M6 27h20v3H6z"/></>:level==='low'?<><path fill="#a85e48" d="M15 6h2v3h2v3h2v3h2v3h2v3h2v6H5v-6h2v-3h2v-3h2v-3h2V9h2z"/><path fill="#d99b73" d="M15 10h2v4h2v4h2v4h2v5H9v-5h2v-4h2v-4h2z"/><path fill="#694f42" d="M15 18h2v3h2v6h-6v-6h2z"/><path fill="#775940" d="M3 27h3v3H3zM26 27h3v3h-3z"/></>:level==='medium'?<><path fill="#886344" d="M6 15h3v14H6zM23 15h3v14h-3zM8 18h16v3H8zM8 25h16v3H8zM15 9h3v20h-3z"/><path fill="#b88b3c" d="M14 5h4v3h3v3h3v3h3v3H5v-3h3v-3h3V8h3z"/><path fill="#e4c477" d="M8 14h16v3H8zM10 21h5v4h-5zM19 21h4v4h-4z"/><path fill="#bba57a" d="M1 23h3v8H1zM0 24h6v2H0z"/></>:<><path fill="#c2d2cf" d="M7 14h19v15H7z"/><path fill="#538c9c" d="M14 5h5v3h3v3h3v3h3v3H4v-3h3v-3h3V8h4z"/><path fill="#356577" d="M5 16h22v3H5zM10 22h5v7h-5z"/><path fill="#759fab" d="M18 21h5v5h-5z"/><path fill="#f0dfad" d="M19 22h3v3h-3z"/><path fill="#607d7c" d="M7 29h20v2H7zM23 7h3v6h-3z"/></>}
    </svg></span>
    <svg className={`certainty-flag ${confident?'sufficient':'limited'}`} data-certainty={assessment.confidence===null?'unknown':confident?'sufficient':'limited'} viewBox="0 0 18 26" aria-hidden="true"><path d="M3 25V2" stroke="#6f7968" strokeWidth="2"/><path className="flag-cloth" d="M4 3h11l-3 4 3 4H4z" stroke="#798475" strokeWidth="1"/>{confident&&<path d="m6 6 2 2 3-3" fill="none" stroke="#fff" strokeWidth="1.3"/>}</svg>
  </span>;
}
