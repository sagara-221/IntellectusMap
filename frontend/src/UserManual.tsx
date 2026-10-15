import {useRef, useState} from 'react';

export default function UserManual() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [edition, setEdition] = useState<'quick'|'detailed'>('quick');
  const title = edition === 'quick' ? '簡易ユーザーマニュアル' : '詳細ユーザーマニュアル';
  return <>
    <button onClick={() => dialog.current?.showModal()}>ユーザーマニュアル</button>
    <dialog ref={dialog} className="user-manual-dialog" aria-labelledby="manual-title">
      <header><h2 id="manual-title">ユーザーマニュアル</h2><button autoFocus onClick={() => dialog.current?.close()} aria-label="ユーザーマニュアルを閉じる">閉じる ×</button></header>
      <nav aria-label="マニュアルの種類">
        <button aria-pressed={edition==='quick'} onClick={()=>setEdition('quick')}>簡易版</button>
        <button aria-pressed={edition==='detailed'} onClick={()=>setEdition('detailed')}>詳細版</button>
        <a href={`/manuals/${edition}.pdf`} target="_blank" rel="noopener noreferrer">PDFを開く ↗</a>
      </nav>
      <iframe key={edition} src={`/manuals/${edition}.html`} title={title}/>
    </dialog>
  </>;
}
