export default function PixelRecorder({working=false,planning=false}:{working?:boolean;planning?:boolean}){
  return <svg className={`pixel-recorder ${working?'writing':''} ${planning?'planning':''}`} width="64" height="64" viewBox="0 0 32 32" role="img" aria-label={working?'記録係・記録中':planning?'記録係・計画中':'記録係・待機中'} shapeRendering="crispEdges">
    <ellipse cx="16" cy="30" rx="10" ry="1" fill="#293e3526"/>
    <path d="M10 5h12v3h2v7H9V8h1z" fill="#594337"/><path d="M11 9h11v8H11z" fill="#efc494"/>
    <path d="M9 5h15v4H7V7h2z" fill="#aa7655"/><path d="M11 3h10v3H11z" fill="#bb9367"/>
    <path d="M12 11h4v3h-4zM18 11h4v3h-4z" fill="#49626a"/><path d="M16 12h2v1h-2z" fill="#49626a"/>
    <path d="M10 17h13v11H9v-9h1z" fill="#89644b"/><path d="M13 17h5v6h-5z" fill="#eee1bb"/>
    <path d="M10 27h5v3H8v-2h2zM19 27h4v2h2v1h-6z" fill="#354738"/>
    <path d="M13 20h13v9H13z" fill="#435e4b"/><g className="recorder-pages"><path d="M14 21h10v6H14z" fill="#fff0c9"/>
    <path d="M16 23h6v1h-6zM16 25h4v1h-4z" fill="#b0a07b"/></g>
    <g className="recorder-pen"><path d="M22 17h2v9h-2z" fill="#e2b04f"/><path d="M22 26h2v2h-2z" fill="#394d3f"/><path d="M24 20h3v3h-3z" fill="#efc494"/></g>
  </svg>;
}
