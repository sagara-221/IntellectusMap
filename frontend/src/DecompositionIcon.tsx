import type {DecompositionStatus} from './types';

export const decompositionLabels:Record<DecompositionStatus,string>={
  available:'分解前',queued:'分解待ち',generating:'バックグラウンドで分解中',ready:'分解済み・展開待ち',failed:'分解失敗・再試行できます',
};
export type QuestionReadiness='unknown'|'missing'|'queued'|'generating'|'ready'|'failed';
export function preparationLabel(status:DecompositionStatus,question:QuestionReadiness){
  return `${decompositionLabels[status]}。${question==='ready'?'問題生成済み':question==='generating'?'問題を生成中':question==='queued'?'問題生成の順番待ち':question==='failed'?'問題の準備に失敗・再試行できます':question==='unknown'?'問題の準備状況は未確認':'問題は未生成'}`;
}
export default function DecompositionIcon({status,question='missing'}:{status:DecompositionStatus;question?:QuestionReadiness}){
  const label=preparationLabel(status,question);
  const open=status==='ready'&&question==='ready';
  return <span className={`decomposition-icon ${status}`} data-decomposition={status} data-question={question} data-chest={status==='ready'?(open?'open':'closed'):undefined} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="#fff9e8" d="M3 1h18v2h2v18h-2v2H3v-2H1V3h2z"/>
      {status==='available'?<><path fill="#89765e" d="M5 7h14v12H5z"/><path fill="#c4ac7d" d="M7 9h10v8H7z"/><path fill="#89765e" d="M11 7h2v12h-2zM5 11h14v2H5z"/></>
      :status==='queued'?<><path fill="#8c7350" d="M6 4h12v2H6zM6 18h12v2H6zM7 6h2v3h2v2h2V9h2V6h2v4h-2v4h2v4h-2v-3h-2v-2h-2v2H9v3H7v-4h2v-4H7z"/><path fill="#d6ae54" d="M9 6h6v2H9zM10 16h4v2h-4z"/></>
      :status==='generating'?<g className="decomposition-pick"><path fill="#966536" d="M5 18h2v-2h2v-2h2v-2h2v-2h2v2h-2v2h-2v2H9v2H7v2H5z"/><path fill="#5b7880" d="M7 5h8v2h3v3h2v5h-2v-3h-3V9h-3V7H7z"/><path fill="#a9c2bd" d="M7 5h8v2H7z"/></g>
      :status==='ready'&&!open?<><path fill="#876431" d="M5 6h14v2h2v12H3V8h2z"/><path fill="#dfb952" d="M5 8h14v10H5z"/><path fill="#876431" d="M3 11h18v2H3zM6 6h2v14H6zM16 6h2v14h-2z"/><path fill="#fff0a5" d="M10 10h4v5h-4z"/></>
      :status==='ready'?<><path fill="#94794e" d="M4 12h16v8H4zM5 5h14v3H5zM3 8h4v3H3zM17 8h4v3h-4z"/><path fill="#e4c88b" d="M6 14h12v4H6z"/><path fill="#3c7962" d="M9 9h2v2h2V9h2V7h2v4h-2v2h-4v-2H9z"/></>
      :<><path fill="#ae6451" d="M5 7h14v13H5z"/><path fill="#fff0db" d="M11 9h2v5h-2zM11 16h2v2h-2z"/><path fill="#ae6451" d="M10 3h4v2h-4z"/></>}
      {question==='ready'&&!open&&<g><path fill="#456a78" d="M16 14h8v10h-8z"/><path fill="#fff4cf" d="M17 15h6v8h-6z"/><path fill="#456a78" d="M18 17h4v1h-4zM18 20h3v1h-3z"/></g>}
      {question==='generating'&&<g className="question-quill"><path fill="#fff4cf" d="M15 14h9v10h-9z"/><path fill="#456a78" d="M21 14h3v3h-2v2h-2v2h-2v2h-2v-4h2v-2h2v-2h1z"/></g>}
      {question==='failed'&&<g><path fill="#a95640" d="M15 14h9v10h-9z"/><path fill="#fff4cf" d="M19 15h2v5h-2zM19 21h2v2h-2z"/></g>}
      {question==='queued'&&<g><path fill="#fff4cf" d="M15 14h9v10h-9z"/><path fill="#86683d" d="M17 15h6v2h-2v3h2v2h-6v-2h2v-3h-2z"/></g>}
    </svg>
  </span>;
}
