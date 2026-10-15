import {useEffect, useRef, useState} from 'react';
import {LoaderCircle, MessageCircle, Plus, Send} from 'lucide-react';
import {api} from './api';
import {API_PREFIX} from './config';
import {getAuthToken, clearAuthToken} from './auth';
import MarkdownContent from './MarkdownContent';
import {type ChatMessage, type Diagnosis, flatten} from './types';

export default function ChatPanel({session, selected, onSession,reception=false}: {session:Diagnosis;selected:string|null;onSession:(next:Diagnosis)=>void;reception?:boolean}) {
  const [text,setText] = useState('');
  const [sending,setSending] = useState(false);
  const [starting,setStarting] = useState(false);
  const [viewedConversationId,setViewedConversationId] = useState<string|null>(null);
  const [phase,setPhase] = useState('');
  const [error,setError] = useState('');
  const [optimistic,setOptimistic] = useState<ChatMessage|null>(null);
  const [draft,setDraft] = useState<{id:string;content:string;conversationId:string}|null>(null);
  const abort = useRef<AbortController|null>(null);
  const newConversationId = useRef<string|null>(null);
  const bottom = useRef<HTMLDivElement|null>(null);
  const callback = useRef(onSession);
  callback.current = onSession;
  const initializing = session.session_id === 'pending_initial';
  const serverBusy = !!session.chat?.foreground_turn_id;
  const currentConversationId=session.chat?.current_conversation_id ?? 'conversation_initial';
  const visibleConversationId=viewedConversationId ?? currentConversationId;
  const archived=visibleConversationId !== currentConversationId;
  const conversations=session.chat?.conversations ?? [{conversation_id:currentConversationId,title:'会話1',created_at:''}];
  const jobs = session.chat?.jobs ?? [];
  const activeJob = jobs.find(job=>job.status==='running') ?? jobs.find(job=>job.status==='queued');
  const completedJobs = jobs.filter(job=>job.status==='complete');
  const lastJob = completedJobs[completedJobs.length-1];
  const reflectedNodes = new Set(jobs.flatMap(job=>job.updated_concept_ids)).size;
  const legacyMessages = session.chat?.messages.some(message=>message.role==='user' && !jobs.some(job=>job.turn_id===message.message_id));
  const phaseLabels = {extracting:'文章から経験を整理中',planning:'知識項目に対応づけ中',updating:'マップを広げています',assessing:'理解の根拠を反映中',complete:'反映しました'};
  const backgroundBusy = session.chat?.background_status === 'running' || session.chat?.background_status === 'queued';
  const pendingEvidence = session.chat?.evidence_queue?.filter(item=>item.status==='pending'||item.status==='waiting').length ?? 0;
  const insufficientEvidence = session.chat?.evidence_queue?.filter(item=>item.status==='insufficient').length ?? 0;
  const reconciliationLabels = {idle:'マップに反映中',waiting:'項目の生成を待って、会話と照合します',matching:'生成した項目と会話を照合中',assessing:'新しい項目に会話の根拠を反映中',adding:'不足する知識項目を追加中'};
  const focus = flatten(session.knowledge_tree).find(node=>node.concept_id===session.chat?.focus_concept_id);
  const selectedNode = flatten(session.knowledge_tree).find(node=>node.concept_id===selected);
  useEffect(()=>{
    if(session.session_id==='pending_initial') return;
    let active=true;
    void api<Diagnosis>(`/sessions/${session.session_id}/chat`).then(next=>{if(active)callback.current(next);}).catch(e=>{if(active)setError(String(e));});
    return ()=>{active=false;abort.current?.abort();};
  },[session.session_id]);
  useEffect(()=>{
    if (!serverBusy && !backgroundBusy) return;
    let active=true;
    const timer=window.setInterval(()=>{void api<Diagnosis>(`/sessions/${session.session_id}/chat`).then(next=>{if(active)callback.current(next);}).catch(()=>{});},1200);
    return ()=>{active=false;window.clearInterval(timer);};
  },[session.session_id,serverBusy,backgroundBusy]);
  useEffect(()=>{bottom.current?.scrollIntoView({block:'nearest'});},[session.chat?.messages.length,draft?.content,phase,visibleConversationId]);
  const messages=(session.chat?.messages ?? []).filter(item=>(item.conversation_id ?? 'conversation_initial')===visibleConversationId);
  if (optimistic && optimistic.conversation_id===visibleConversationId && !messages.some(item=>item.message_id===optimistic.message_id)) messages.push(optimistic);
  if (draft && draft.conversationId===visibleConversationId && !messages.some(item=>item.message_id===draft.id)) messages.push({message_id:draft.id,role:'assistant',content:draft.content,status:'pending',created_at:'',conversation_id:draft.conversationId});
  const lastFailed = [...messages].reverse().find(item=>item.role==='assistant' && item.status==='failed');
  const failedUser = lastFailed ? messages.find(item=>item.message_id===lastFailed.message_id.replace(/_reply$/,'')) : undefined;
  async function send(retry?:ChatMessage) {
    const content=retry?.content ?? text.trim();
    if (initializing || !content || sending || starting || serverBusy || archived || session.complete) return;
    const messageId=retry?.message_id ?? crypto.randomUUID();
    const replyId=messageId+'_reply';
    const controller=new AbortController();
    abort.current=controller;
    setSending(true);setPhase('assessing');setError('');setText('');
    setOptimistic({message_id:messageId,role:'user',content,status:'complete',created_at:new Date().toISOString(),conversation_id:currentConversationId});
    setDraft({id:replyId,content:'',conversationId:currentConversationId});
    let finished=false;
    let reply='';
    try {
      const token=getAuthToken();
      const response=await fetch(`${API_PREFIX}/sessions/${session.session_id}/chat`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({message_id:messageId,content,concept_id:selectedNode?.depth ? selectedNode.concept_id : null,conversation_id:currentConversationId}),signal:controller.signal});
      if (!response.ok) {
        const data=await response.json().catch(()=>null);
        if(response.status===401){clearAuthToken();sessionStorage.removeItem('diagnostic-session');window.dispatchEvent(new CustomEvent('auth:expired'));}
        throw new Error(typeof data?.detail==='string' ? data.detail : `送信できませんでした (${response.status})`);
      }
      if (!response.body) throw new Error('返答の通信を開始できませんでした。');
      const reader=response.body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      while (true) {
        const {done,value}=await reader.read();
        buffer+=decoder.decode(value,{stream:!done});
        let boundary:RegExpExecArray|null;
        while ((boundary=/\r?\n\r?\n/.exec(buffer))) {
          const packet=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
          const lines=packet.split(/\r?\n/);
          const name=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();
          const raw=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if (!raw) continue;
          const data=JSON.parse(raw);
          if (data.session) callback.current(data.session);
          if (name==='phase') setPhase(data.phase);
          if (name==='delta') {reply+=data.text;setDraft({id:replyId,content:reply,conversationId:currentConversationId});}
          if (name==='error') {finished=true;setError(data.message);}
          if (name==='complete') {finished=true;setDraft(null);setOptimistic(null);}
        }
        if (done) break;
      }
      if (!finished) throw new Error('通信が中断されました。保存された返答を確認しています。');
    } catch(e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : '送信に失敗しました。');
        try {
          const saved=await api<Diagnosis>(`/sessions/${session.session_id}/chat`);
          callback.current(saved);
          if (!saved.chat?.messages.some(item=>item.message_id===messageId)) setText(content);
        } catch {setText(content);}
      }
    } finally {
      if (!controller.signal.aborted) {setSending(false);setPhase('');setDraft(null);setOptimistic(null);}
    }
  }
  async function retryInitial() {
    setError('');
    try {callback.current(await api<Diagnosis>(`/sessions/${session.session_id}/initial/retry`,{}));}
    catch(e) {setError(e instanceof Error?e.message:'初期マップを再試行できませんでした。');}
  }
  async function reprocess() {
    setError('');
    try {callback.current(await api<Diagnosis>(`/sessions/${session.session_id}/chat/reprocess`,{}));}
    catch(e) {setError(e instanceof Error?e.message:'マップへの反映を開始できませんでした。');}
  }
  async function startConversation() {
    if (initializing || starting || sending || serverBusy || session.complete) return;
    setStarting(true);setError('');
    try {
      newConversationId.current ??= crypto.randomUUID();
      const next=await api<Diagnosis>(`/sessions/${session.session_id}/chat/conversations`,{conversation_id:newConversationId.current});
      callback.current(next);setViewedConversationId(null);setText('');setOptimistic(null);setDraft(null);setPhase('');
      newConversationId.current=null;
    } catch(e) {setError(e instanceof Error ? e.message : '新しい会話を開始できませんでした。');}
    finally {setStarting(false);}
  }
  return <section className="question-panel panel chat-panel" aria-label="会話で理解を確認">
    {!reception && <div className="panel-heading"><div><MessageCircle size={17}/><h2>会話で理解を確認</h2></div><span>{messages.filter(item=>item.role==='user').length} 発言</span></div>}
    <div className="chat-conversation-toolbar"><label>会話履歴<select aria-label="会話履歴" value={visibleConversationId} onChange={e=>{setViewedConversationId(e.target.value===currentConversationId ? null : e.target.value);setError('');}}>{conversations.map((item,index)=><option key={item.conversation_id} value={item.conversation_id}>{`${item.title===`会話${index+1}` ? item.title : `会話${index+1} · ${item.title}`}${item.conversation_id===currentConversationId ? '（現在）' : ''}`}</option>)}</select></label><button className="secondary" disabled={initializing||starting||sending||serverBusy||session.complete} title="マップ・理解度・過去の会話を残して、新しい会話を始めます" onClick={()=>void startConversation()}>{starting?<LoaderCircle className="spin" size={14}/>:<Plus size={14}/>}新しい会話</button></div>
    {archived && <p className="chat-context">過去の会話を表示しています。<button className="text-button" onClick={()=>setViewedConversationId(null)}>現在の会話に戻る</button></p>}
    {(!reception || selectedNode?.depth) && <p className="chat-context">{selectedNode?.depth ? `選択中：${selectedNode.concept_name}` : focus ? `話題：${focus.concept_name}` : `${session.theme}について、経験や気になっていることから話せます。`}</p>}
    <div className="chat-messages" aria-live="polite" aria-relevant="additions text">
      {!messages.length && <div className="chat-welcome"><span className="reception-greeting">ようこそ、探索受付へ</span><h3>「{session.theme}」のこと、<br/>少し聞かせてください。</h3><p>やってみたこと、知っていること、つまずいたこと。<br/>最初の地図に、お話を手がかりにした項目を加えていきます。</p><div className="chat-starters">{['学びたいことから話す','経験したことから話す','困っていることを相談する'].map((label,i)=><button type="button" key={label} disabled={initializing} onClick={()=>{setText([`${session.theme}について、これから学びたいのは`,`${session.theme}で、これまでに取り組んだことは`,`${session.theme}について、いま困っているのは`][i]);document.getElementById('chat-message')?.focus();}}>{label}<span>↗</span></button>)}</div></div>}

      {messages.map(message=>{
        const content=draft?.id===message.message_id ? draft.content : message.content;
        return <article className={`chat-message ${message.role}`} key={message.message_id}><small>{message.role==='user'?'あなた':reception?'受付係':'IntellectusMap'}</small>{content ? <MarkdownContent>{content}</MarkdownContent> : message.status==='pending' && <span className="chat-thinking"><LoaderCircle size={15} className="spin"/>{phase==='replying'?'返答を準備しています…':'話してくれた内容を確認しています…'}</span>}{message.status==='failed' && <small className="chat-failed">返答が中断されました</small>}</article>;
      })}
      <div ref={bottom}/>
    </div>
    {initializing && <p className="chat-background" role="status"><LoaderCircle size={13} className="spin"/>受付に接続しています…</p>}
    {!initializing && session.initial_root_pending && <p className="chat-background" role="status">{session.knowledge_tree.expansion_error ? <>{session.knowledge_tree.expansion_error}<button className="text-button" onClick={()=>void retryInitial()}>初期マップを再試行</button></> : <>最初の知識マップを作成中です。会話はこのまま始められます。</>}</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {failedUser && !archived && !sending && !serverBusy && <button className="text-button" onClick={()=>void send(failedUser)}>同じ発言を再送する</button>}
    {backgroundBusy && <p className="chat-background" role="status"><LoaderCircle size={13} className="spin"/>{activeJob ? phaseLabels[activeJob.phase] : reconciliationLabels[session.chat?.reconciliation_phase ?? 'idle']}{activeJob?.phase==='extracting' && activeJob.total_chunks>1 && `（${activeJob.completed_chunks.length} / ${activeJob.total_chunks}）`}。{reflectedNodes>0 && `${reflectedNodes} 項目反映済み。`}会話は続けられます。</p>}
    <details className="chat-reflection-details"><summary>{backgroundBusy ? '地図に反映中' : reflectedNodes>0 ? `${reflectedNodes} 項目に反映` : '地図への反映状況'}</summary>
    {!backgroundBusy && reflectedNodes>0 && <p className="chat-update-summary" role="status">会話から {reflectedNodes} 項目に反映しました。項目の詳細で根拠を確認できます。</p>}
    {!backgroundBusy && pendingEvidence>0 && <p className="chat-update-summary">{pendingEvidence} 件の情報は対応する項目を保留中です。項目が増えたときに再照合します。</p>}
    {!backgroundBusy && insufficientEvidence>0 && <p className="chat-update-summary">{insufficientEvidence} 件の情報は対応先がありますが、判定の根拠が足りません。続きの会話から確認できます。</p>}
    {lastJob?.deferred_reasons.length ? <details className="chat-deferred"><summary>反映を保留した内容</summary>{lastJob.deferred_reasons.map((reason,index)=><p key={index}>{reason}</p>)}</details> : null}
    {session.chat?.background_status==='failed' && <p className="chat-background">{session.chat.background_error}</p>}
    {!session.complete && !backgroundBusy && (legacyMessages || session.chat?.background_status==='failed' || jobs.some(job=>job.status==='failed')) && <button className="text-button" onClick={()=>void reprocess()}>{legacyMessages?'過去の会話をマップに反映':'マップへの反映を再試行'}</button>}
    </details>
    {!archived && <form className="chat-composer" onSubmit={e=>{e.preventDefault();void send();}}><label htmlFor="chat-message"><span className="chat-input-label">話したいこと</span><textarea id="chat-message" value={text} onChange={e=>setText(e.target.value)} rows={2} maxLength={100000} disabled={initializing||starting||session.complete} placeholder="経験や考え、気になっていることを自由に書いてください"/></label><button className="primary" disabled={initializing||starting||sending||serverBusy||!text.trim()||session.complete}>{sending||serverBusy?<LoaderCircle className="spin" size={15}/>:<Send size={15}/>}送信</button></form>}
  </section>;
}
