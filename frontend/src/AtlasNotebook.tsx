import {useRef, useState, type ReactNode} from 'react';
import {ChevronLeft, ChevronRight, Maximize2, Minimize2, X} from 'lucide-react';

export type NotebookPage = 'request' | 'question' | 'record';
const pages: {id: NotebookPage; label: string}[] = [
  {id:'request', label:'調査依頼'}, {id:'question', label:'問題・回答'},
  {id:'record', label:'調査記録'},
];

export default function AtlasNotebook({open,onClose,page,onPage,showQuestionPage,request,question,record}: {
  open:boolean; onClose:()=>void; page:NotebookPage; onPage:(page:NotebookPage)=>void;
  showQuestionPage:boolean;
  request:ReactNode; question:ReactNode; record:ReactNode;
}) {
  const [wide,setWide] = useState(false);
  const [turn,setTurn] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const visiblePages=showQuestionPage?pages:pages.filter(item=>item.id!=='question');
  const currentPage=visiblePages.some(item=>item.id===page)?page:'request';
  const index=visiblePages.findIndex(item=>item.id===currentPage);
  function go(next:NotebookPage) {
    if (next===currentPage) return;
    onPage(next);setTurn(n=>n+1);
    body.current?.scrollTo({top:0});
  }
  return <aside id="atlas-notebook" aria-label="調査手帳" hidden={!open} className={`atlas-inspector panel page-${currentPage} ${wide?'notebook-wide':''}`}>
    <header className="inspector-heading"><div><span>探索の記録</span><h2>調査手帳</h2></div><div>
      <button onClick={()=>setWide(v=>!v)} aria-label={wide?'調査手帳を小さくする':'調査手帳を広げる'}>{wide?<Minimize2 size={17}/>:<Maximize2 size={17}/>}</button>
      <button onClick={onClose} aria-label="調査手帳を閉じる"><X size={19}/></button>
    </div></header>
    <nav className="inspector-tabs" role="tablist" aria-label="調査手帳のページ">{visiblePages.map((item,i)=><button key={item.id} role="tab" id={`tab-${item.id}`} aria-selected={currentPage===item.id} aria-controls={`page-${item.id}`} onClick={()=>go(item.id)}><span>{String(i+1).padStart(2,'0')}</span> {item.label}</button>)}</nav>
    <div ref={body} className="inspector-scroll">
      {/* Keep forms mounted: changing pages or widening the book preserves drafts. */}
      {visiblePages.map(item=><div key={item.id} id={`page-${item.id}`} role="tabpanel" aria-labelledby={`tab-${item.id}`} hidden={currentPage!==item.id} className="notebook-page">
        {{request,question,record}[item.id]}
      </div>)}
      <span key={turn} className="notebook-page-turn" aria-hidden="true"/>
    </div>
    <footer className="notebook-page-footer"><button aria-label="前のページ" disabled={index===0} onClick={()=>go(visiblePages[index-1].id)}><ChevronLeft size={16}/></button><span>{index+1} / {visiblePages.length}</span><button aria-label="次のページ" disabled={index===visiblePages.length-1} onClick={()=>go(visiblePages[index+1].id)}><ChevronRight size={16}/></button></footer>
  </aside>;
}
