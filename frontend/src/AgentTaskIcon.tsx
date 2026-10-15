import type {AgentAction} from './map-crew';

export default function AgentTaskIcon({action}:{action:AgentAction}){
  if(action==='dig'||action==='write'||action==='plan'||action==='reply')return null;
  return <svg className="agent-task-icon" viewBox="0 0 32 32" shapeRendering="crispEdges" aria-hidden="true">
    {action==='prefetch'&&<><path fill="#637e72" d="M4 7h24v21H4z"/><path fill="#fff4d3" d="M6 9h20v16H6z"/><path fill="#c6b581" d="M15 9h2v16h-2zM8 12h5v2H8zM19 12h5v2h-5zM8 17h5v2H8z"/><g className="task-moving"><path fill="#dce8c3" d="M17 8h9v16h-9z"/><path fill="#819679" d="M19 12h5v2h-5zM19 17h4v2h-4z"/></g></>}
    {action==='build'&&<><path d="M7 22h19v6H7z" fill="#bc8755"/><path d="M7 22h9v3H7zm10 3h9v3h-9z" fill="#e3bd79"/><g className="task-moving"><path d="M14 4h3v16h-3z" fill="#795b3e"/><path d="M7 4h17v5H7z" fill="#66847b"/><path d="M8 5h15v2H8z" fill="#b9d1c3"/></g></>}
    {action==='question'&&<><path d="M6 5h20v24H6z" fill="#6b735d"/><path d="M8 7h16v19H8z" fill="#fff5d9"/><path d="M11 11h10v2H11zm0 5h8v2h-8zm0 5h6v2h-6z" fill="#9ba88a"/><g className="task-moving"><path d="M22 12h3v13h-3z" fill="#bb8149"/><path d="M22 24h3l-2 4z" fill="#526c6b"/></g></>}
    {action==='grade'&&<><path d="M7 19h19v9H7z" fill="#fff1d4"/><path d="M10 23l4 3 7-6" fill="none" stroke="#54866a" strokeWidth="3"/><g className="task-moving"><path d="M13 4h7v11h-7z" fill="#825a44"/><path d="M10 14h13v4H10z" fill="#ab7052"/></g></>}
    {action==='inspect'&&<g className="task-moving"><path d="M8 5h13v3h3v12h-3v3H8v-3H5V8h3z" fill="#627c72"/><path d="M9 9h11v10H9z" fill="#d8ebe4"/><path d="M21 21h4v3h3v4h-4v-3h-3z" fill="#8d6647"/></g>}
    {action==='merge'&&<><path d="M10 5h14v18H10z" fill="#6d937a"/><path d="M12 7h10v13H12z" fill="#eaf1d9"/><g className="task-moving"><path d="M5 10h13v17H5z" fill="#567f70"/><path d="M7 12h9v12H7z" fill="#f9ebc5"/><path d="M10 15h3v3h-3z" fill="#c49855"/></g></>}
  </svg>;
}
