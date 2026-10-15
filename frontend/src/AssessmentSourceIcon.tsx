export type AssessmentSource = 'question' | 'conversation' | 'self_report';
export const assessmentSourceLabels:Record<AssessmentSource,string> = {
  question:'問題回答による評価', conversation:'チャットからの推定', self_report:'自己評価',
};

export default function AssessmentSourceIcon({source,provisional=false}:{source:AssessmentSource;provisional?:boolean}) {
  const label=assessmentSourceLabels[source]+(provisional?'・暫定（未検証）':'');
  return <span className="assessment-source-icon" data-assessment-source={source} data-provisional={provisional} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 20 20" shapeRendering="crispEdges" aria-hidden="true">
      {source==='question'?<><path fill="#386276" d="M4 1h10v2h2v15H4z"/><path fill="#fff9e5" d="M6 3h7v3h1v10H6z"/><path fill="#386276" d="M7 6h5v1H7zM7 9h5v1H7z"/><path fill="#b27d26" d="M9 13h2v2H9zM11 11h2v2h-2zM13 9h2v2h-2z"/></>
        :source==='conversation'?<><path fill="#416653" d="M2 3h15v10H9v2H7v2H5v-4H2z"/><path fill="#edf4dd" d="M4 5h11v6H7v2H5v-2H4z"/><path fill="#416653" d="M5 7h2v2H5zM9 7h2v2H9zM13 7h1v2h-1z"/></>
        :<><path fill="#82603e" d="M7 2h6v6H7zM5 10h10v2h2v5H3v-5h2z"/><path fill="#f1d69e" d="M9 3h3v4H9zM6 12h8v4H6z"/></>}
      {provisional&&<><path fill="#f5e6bc" d="M12 11h8v9h-8z"/><path fill="#795431" d="M14 12h4v1h1v2h-2v2h-2v-3h2v-1h-3zM15 18h2v1h-2z"/></>}
    </svg>
  </span>;
}
