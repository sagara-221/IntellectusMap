import {Maximize2, Minimize2, X} from 'lucide-react';
import ChatPanel from './ChatPanel';
import PixelReceptionist from './PixelReceptionist';
import type {Diagnosis} from './types';

export default function AtlasChat({open,wide,onWide,onClose,session,selected,onSession}:{
  open:boolean;wide:boolean;onWide:()=>void;onClose:()=>void;
  session:Diagnosis;selected:string|null;onSession:(next:Diagnosis)=>void;
}){
  return <aside id="atlas-chat" hidden={!open} className={`atlas-chat ${wide?'chat-wide':''}`} aria-label="探索受付">
    <header className={`chat-window-heading ${session.agent_runtime?.counts.reception?.running?'reception-talking':''}`}><span className="reception-avatar" data-reception-anchor><PixelReceptionist/></span><div><h2>探索受付</h2><span>会話から、知識の地図へ</span></div>
      <button onClick={onWide} aria-label={wide?'チャットを小さくする':'チャットを広げる'}>{wide?<Minimize2 size={18}/>:<Maximize2 size={18}/>}</button>
      <button onClick={onClose} aria-label="チャットを閉じる"><X size={20}/></button>
    </header>
    <ChatPanel session={session} selected={selected} onSession={onSession} reception/>
  </aside>;
}
