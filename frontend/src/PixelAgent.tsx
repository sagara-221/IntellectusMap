export type AgentTool = 'pick'|'pen'|'lens'|'documents';
export default function Miner({state='idle', tint='#d79539',tool='pick'}:{state?:string;tint?:string;tool?:AgentTool}) {
  const toolName={pick:'ツルハシ',pen:'ペンと用紙',lens:'虫眼鏡',documents:'資料'}[tool];
  return <svg className={`miner ${state}`} data-tool={tool} viewBox="0 0 32 32" role="img" aria-label={`${toolName}を持つ係・${state==='work'?'作業中':state==='walk'?'移動中':'待機中'}`} shapeRendering="crispEdges">
    <ellipse cx="16" cy="30" rx="10" ry="2" fill="#293e3526"/>
    <g className="miner-body"><path fill="#33483f" d="M9 13h14v14H9z"/><path fill={tint} d="M9 16h14v8H9z"/>
    <path fill="#eec693" d="M10 8h12v8H10zM7 17h3v7H7zM23 17h3v7h-3z"/>
    <path fill="#654a36" d="M10 9h3v3h-3zM10 14h12v3H10z"/><path fill="#283c34" d="M18 10h2v2h-2z"/>
    <path fill={tint} d="M10 3h11v3h3v4H7V6h3z"/><path fill="#f4d36c" d="M7 8h18v3H7z"/><path fill="#fff5bd" d="M16 4h4v4h-4z"/>
    <path fill="#546f68" d="M11 20h4v6h-4zM18 20h4v6h-4z"/><path fill="#dfc294" d="M12 17h2v2h-2zM19 17h2v2h-2z"/></g>
    <path className="leg left" fill="#33443d" d="M10 25h5v5H8v-3h2z"/><path className="leg right" fill="#33443d" d="M18 25h5v3h2v2h-7z"/>
    {tool==='pick'&&<g className="pick"><path fill="#88603e" d="M25 14h2v15h-2z"/><path fill="#526d70" d="M21 12h9v3h-9zM19 14h3v3h-3zM29 14h3v3h-3z"/><path fill="#bed3ce" d="M22 11h7v2h-7z"/></g>}
    {tool==='pen'&&<g><path fill="#596f77" d="M21 16h9v12h-9z"/><path fill="#fff1d2" d="M22 17h7v9h-7z"/><path fill="#9da88e" d="M23 19h4v1h-4zM23 22h3v1h-3z"/><path fill="#ba8144" d="M28 13h2v11h-2z"/><path fill="#344d59" d="M28 24h2v2h-2z"/></g>}
    {tool==='lens'&&<g><path fill="#537c75" d="M23 12h6v2h2v7h-2v2h-6v-2h-2v-7h2z"/><path fill="#bde7e6" d="M24 15h5v5h-5z"/><path fill="#fffbea" d="M24 15h2v2h-2z"/><path fill="#956841" d="M24 23h3v7h-3z"/></g>}
    {tool==='documents'&&<g><path fill="#587f70" d="M23 13h8v12h-8z"/><path fill="#e1edcd" d="M24 14h6v9h-6z"/><path fill="#856846" d="M20 18h9v11h-9z"/><path fill="#fff1d0" d="M21 19h7v8h-7z"/><path fill="#b79a59" d="M23 21h3v2h-3zM22 25h5v1h-5z"/></g>}
  </svg>;
}
