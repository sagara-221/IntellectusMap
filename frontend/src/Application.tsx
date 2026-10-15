// ==============================================================================
// フロントエンド メインエントリーポイント & UIオーケストレーター (App)
// 用途: 画面全体の状態管理、セッション作成・復元、出題・回答・自己申告UI、Googleログイン
// ==============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import LiveAtlasMap from './LiveAtlasMap';
import JudgeLogin from './JudgeLogin';
import UserManual from './UserManual';
import AtlasStart from './AtlasStart';
import ConversationEvidence from './ConversationEvidence';
import AtlasChat from './AtlasChat';
import AtlasNotebook, {type NotebookPage} from './AtlasNotebook';
import { atlasVisibleIds, reconcileSession, redirectedId } from './atlas-session';
import {progressActivity, type MapActivity} from './live-map-jobs';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Clock, Download, GitBranch, History, LoaderCircle, Lock, LogIn, LogOut, Map, Menu, Plus, RotateCcw, Sparkles, Target, Trash2, User, X } from 'lucide-react';
import KnowledgeTree from './KnowledgeTree';
import { DivergenceDrawer, MapManager, UnderstandingPage, type DivergenceResult, type WideningState } from './MapPages';
import KnowledgeNodeList from './KnowledgeNodeList';
import MarkdownContent from './MarkdownContent';
import ChatPanel from './ChatPanel';
import { api, apiMethod, apiStream, type AgentProgress } from './api';
import { AgentStatusBadge } from './AgentStatusBadge';
import { getCurrentUser, setAuthToken, clearAuthToken, getAuthToken, loginWithBasicAuth, type UserProfile } from './auth';
import { type DecompositionStatus, type Diagnosis, type Evidence, type KnowledgeNode, type QuestionType, type SessionSummary, type SurveyLevel, answerFormatLabels, certaintyLabel, understandingLabel, percent, statusLabel, flatten, visibleConceptIds } from './types';
import './style.css';

// 設問タイプおよび採点結果の日本語表示ラベル
const typeLabels: Record<QuestionType,string> = {multiple_choice:'4択', yes_no:'正誤 (◯✕)', short_answer:'短答式', short_explanation:'短い説明', free_response:'記述式'};
const resultLabels: Record<string,string> = {correct:'正解です', partially_correct:'一部を確認できました', incorrect:'確認したい点が見つかりました', ungradable:'今回は採点できませんでした'};

/**
 * 学習診断アプリケーション メインUIコンポーネント
 */
export default function App({atlas = false}: {atlas?: boolean}) {

  const [user, setUser] = useState<UserProfile | null>(() => getCurrentUser());
  const [session, setSession] = useState<Diagnosis | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activePanel, setActivePanel] = useState<'notebook'|'chat'|null>(null);
  const [chatWide, setChatWide] = useState(true);
  const notebookOpen = activePanel === 'notebook';
  // Incoming questions and map updates must not interrupt an open conversation.
  function setNotebookOpen(value: boolean | ((open:boolean)=>boolean)) {
    setActivePanel(current => current === 'chat' ? current :
      (typeof value === 'function' ? value(current === 'notebook') : value) ? 'notebook' : null);
  }
  const [notebookPage, setNotebookPage] = useState<NotebookPage>('request');
  const [assessmentRequests,setAssessmentRequests] = useState<Record<string,'saving'|'expanding'|'question'>>({});
  const [questionRequest,setQuestionRequest] = useState<{sessionId:string;conceptId:string}|null>(null);
  const [operations, setOperations] = useState<Record<string, MapActivity>>({});
  const expansionRequests = useRef(new Set<string>());
  const selectionVersion = useRef(0);
  const sessionRef = useRef(session); sessionRef.current = session;
  const selectedRef = useRef<string | null>(null);
  function initialSelection(next: Diagnosis, requested?: string): string {
    const remembered=atlas?sessionStorage.getItem('atlas-selected:'+next.session_id):null;
    const resolved=redirectedId(next,requested??remembered);
    return resolved && flatten(next.knowledge_tree).some(node=>node.concept_id===resolved) ? resolved
      : next.pending_review?.concept_id ?? next.next_question?.concept_id ?? next.active_concept_id ?? next.knowledge_tree.concept_id;
  }
  function updateProgress(id: string, progress: AgentProgress) {
    setAgentProgress(progress);
    setOperations(current => ({...current, [id]: progressActivity(progress)}));
  }
  function finishOperation(id: string) {
    setOperations(current => {const next={...current};delete next[id];return next;});
  }
  useEffect(() => {
    const saved=session?.session_id?sessionStorage.getItem('atlas-expanded:'+session.session_id):null;
    try {setExpandedIds(new Set(saved?JSON.parse(saved):[]));} catch {setExpandedIds(new Set());}
    setNotebookPage('request');setOperations({});
  }, [session?.session_id]);
  const [assessmentMethod, setAssessmentMethod] = useState<'manual'|'chat'>(() => sessionStorage.getItem('assessment-method') === 'chat' ? 'chat' : 'manual');
  useEffect(() => sessionStorage.setItem('assessment-method', assessmentMethod), [assessmentMethod]);
  const applyChatSession = useCallback((next: Diagnosis) => setSession(current => current?.session_id === next.session_id ? reconcileSession(current,next) : current), []);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<'explore'|'maps'|'summary'|'nodes'>('explore');
  const [mapDetailId, setMapDetailId] = useState<string|null>(null);
  const [divergenceNode, setDivergenceNode] = useState<KnowledgeNode|null>(null);
  const [widening, setWidening] = useState<WideningState|null>(null);
  const [connectionEntry, setConnectionEntry] = useState<{mode:'list'|'map';revision:number}>({mode:'list',revision:0});
  const wideningRequest = useRef<string|null>(null);
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      const search = new URLSearchParams(window.location.search);
      if (search.get('theme')) return search.get('theme')!;
      if (search.get('test') === 'true' || window.location.hash === '#test' || localStorage.getItem('kgm_id_token')?.startsWith('test_')) {
        return '微分';
      }
    }
    return '';
  });
  const [syllabus, setSyllabus] = useState('');
  const [ready, setReady] = useState(false);
  const [configurationError, setConfigurationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyTarget,setBusyTarget] = useState<{sessionId:string|undefined;conceptId:string|null}|null>(null);
  const [agentProgress, setAgentProgress] = useState<AgentProgress | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  selectedRef.current = selected;
  useEffect(()=>{
    if(atlas && session && selected && flatten(session.knowledge_tree).some(node=>node.concept_id===selected))sessionStorage.setItem('atlas-selected:'+session.session_id,selected);
  },[atlas,session?.session_id,selected]);
  useEffect(() => {
    if (atlas && selected && selected !== session?.knowledge_tree.concept_id) {setNotebookOpen(true);setNotebookPage('request');}
  }, [atlas, selected]);
  const [answer, setAnswer] = useState('');
  const [confidence, setConfidence] = useState<string>('');
  const [latestFeedback, setFeedback] = useState<Evidence | null>(null);
  const feedback = !atlas || latestFeedback?.concept_id===selected ? latestFeedback : null;
  useEffect(() => {
    if (atlas && [session?.next_question, latestFeedback, session?.pending_review].some(item=>item?.concept_id===selectedRef.current)) {
      setNotebookOpen(true);setNotebookPage('question');
    }
  }, [atlas, session?.next_question?.question_id, latestFeedback, session?.pending_review?.review_id]);
  const [assessingConceptId, setAssessingConceptId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addedConceptName, setAddedConceptName] = useState('');
  const [addedConceptNote, setAddedConceptNote] = useState('');
  const [showTestAuthModal, setShowTestAuthModal] = useState(false);
  const started = useRef(Date.now());
  const inFlight = useRef(false);
  const [decomposingIds, setDecomposingIds] = useState<Set<string>>(new Set());
  const hasGeneratingNodes = !!session && (Object.values(session.decomposition_statuses ?? {}).some(status=>status==='generating'||status==='queued') || decomposingIds.size > 0 || session.agent_runtime?.jobs.some(job=>job.status==='running'||job.status==='queued'));
  const needsQuestion = !!session && !session.complete && !session.pending_review && !session.next_question && session.exploration_mode !== 'manual';

  const loadHistory = useCallback(() => {
    if (!user) {
      setHistory([]);
      return;
    }
    api<SessionSummary[]>('/sessions')
      .then(items => setHistory(items))
      .catch(() => {});
  }, [user]);

  const selectSession = async (sid: string) => {
    if (session?.session_id === sid) return;
    setBusy(true);
    setError('');
    try {
      const s = await api<Diagnosis>(`/sessions/${sid}`);
      setSession(s);
      sessionStorage.setItem('diagnostic-session', s.session_id);
      setShowSetup(false);
      setSelected(initialSelection(s));
      setFeedback(null);
      setView('explore');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'セッションの読み込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const startNewSession = () => {
    setSession(null);
    setShowSetup(true);
    sessionStorage.removeItem('diagnostic-session');
    setSelected(null);
    setFeedback(null);
    setError('');
    setView('explore');
  };

  const logout = () => {
    clearAuthToken();
    sessionStorage.removeItem('diagnostic-session');
    setUser(null);
    setSession(null);
    setHistory([]);
    setShowSetup(true);
  };

  const handleCredentialResponse = (response: {credential: string}) => {
    if (response?.credential) {
      setAuthToken(response.credential);
      setUser(getCurrentUser());
    }
  };

  const clientId = (import.meta as unknown as {env?: Record<string, string>}).env?.VITE_GOOGLE_CLIENT_ID || '510937495387-idt41p8rts3bjo9qtf7f9o70e97v0mg9.apps.googleusercontent.com';

  const promptGoogleLogin = () => {
    const google = (window as unknown as {google?: {accounts?: {id?: {prompt: () => void}}}}).google;
    if (google?.accounts?.id?.prompt) {
      google.accounts.id.prompt();
    }
  };

  useEffect(() => {
    let initialized=false;
    const initialize=()=>{
    const google = (window as unknown as {google?: {accounts?: {id?: {initialize: (opts: unknown) => void; renderButton?: (el: HTMLElement, opts: unknown) => void}}}}).google;
    if (google?.accounts?.id?.initialize) {
      if(initialized)return;initialized=true;
      google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredentialResponse,
        auto_select: false,
      });
      const btnEl = document.getElementById('google-login-btn-container');
      if (btnEl && google.accounts.id.renderButton) {
        google.accounts.id.renderButton(btnEl, {
          theme: 'filled_blue',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 250,
        });
      }
    }
    };
    initialize();
    const script=document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    script?.addEventListener('load',initialize);
    return ()=>script?.removeEventListener('load',initialize);
  }, [user, clientId]);

  useEffect(() => {
    const handleAuthExpired = () => {
      setUser(null);
      setError('ログインの有効期限が切れました。再度ログインしてください。');
      promptGoogleLogin();
    };
    window.addEventListener('auth:expired', handleAuthExpired);
    return () => window.removeEventListener('auth:expired', handleAuthExpired);
  }, []);

  // テスト用URLパラメータ (?test=true, ?guest=true, #test) によるアクセス
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (search.get('test') === 'true' || search.get('guest') === 'true' || window.location.hash === '#test') {
      const current = getCurrentUser();
      if (!current) {
        setShowTestAuthModal(true);
      } else {
        setUser(current);
      }
    }
  }, []);

  useEffect(() => {
    api<{gemini_ready: boolean; gemini_configuration_error: string | null}>('/health')
      .then(r => { setReady(r.gemini_ready); setConfigurationError(r.gemini_configuration_error ?? ''); })
      .catch(() => setError('サーバーに接続できません。バックエンドの起動を確認してください。'));
    if (user) {
      loadHistory();
      const sid = sessionStorage.getItem('diagnostic-session');
      if (sid) {
        api<Diagnosis>(`/sessions/${sid}`).then(s => {
          // The user may have returned home while restoration was in flight.
          if (sessionStorage.getItem('diagnostic-session') !== sid) return;
          setSession(s);
          setShowSetup(false);
          setSelected(initialSelection(s));
        }).catch(() => {
          if (sessionStorage.getItem('diagnostic-session') === sid) sessionStorage.removeItem('diagnostic-session');
        });
      }
    }
  }, [user, loadHistory]);

  useEffect(() => { setAnswer(''); setConfidence(''); started.current = Date.now(); }, [session?.next_question?.question_id, latestFeedback]);
  useEffect(() => { setShowAddForm(false); setAddedConceptName(''); setAddedConceptNote(''); }, [selected]);

  // ポーリング: エージェント稼働中は800ms間隔で高頻度ポーリングし、1タスク完了ごとに即時グラフ更新
  useEffect(() => {
    if (!session || !user || !getAuthToken() || session.session_id === 'pending_initial' || session.complete) return;
    const sid = session.session_id;
    let stopped = false;
    const interval = hasGeneratingNodes ? 800 : 2000;
    const timer = window.setInterval(() => {
      if (stopped || !getAuthToken()) return;
      void api<Diagnosis>(`/sessions/${sid}`).then(next => setSession(current => {
        if (!current || current.session_id !== sid) return current;
        return reconcileSession(current, next);
      })).catch(err => {
        if (err instanceof Error && err.message.includes('401')) {
          stopped = true;
          window.clearInterval(timer);
        }
      });
    }, interval);
    return () => window.clearInterval(timer);
  }, [session?.session_id, session?.complete, user, hasGeneratingNodes, decomposingIds]);


  async function run(
    action: (onProgress: (p: AgentProgress) => void) => Promise<Diagnosis>,
    keepFeedback = false,
    preserveSelection = false,
    skipResetProgress = false,
    conceptId: string|null = selectedRef.current
  ): Promise<boolean> {
    if (inFlight.current) return false;
    const originSessionId = sessionRef.current?.session_id;
    const selectionAtStart = selectionVersion.current;
    const operationId = crypto.randomUUID();
    inFlight.current = true; setBusy(true); setError('');
    setBusyTarget({sessionId:originSessionId,conceptId});
    if (!skipResetProgress) setAgentProgress(null);
    try {
      const s = await action((p) => updateProgress(operationId,p));
      if (sessionRef.current?.session_id !== originSessionId && sessionRef.current?.session_id !== 'pending_initial') return false;
      sessionRef.current = reconcileSession(sessionRef.current, s);
      setSession(current => reconcileSession(current, s));
      sessionStorage.setItem('diagnostic-session', s.session_id);
      setShowSetup(false);
      if (selectionVersion.current === selectionAtStart) {
        const retained = redirectedId(s, selectedRef.current);
        setSelected(preserveSelection && retained && flatten(s.knowledge_tree).some(n=>n.concept_id===retained) ? retained : keepFeedback && s.evaluation ? s.evaluation.concept_id : s.pending_review?.concept_id ?? s.next_question?.concept_id ?? s.active_concept_id ?? retained ?? s.knowledge_tree.concept_id);
      }

      setError(s.error ?? '');
      if (keepFeedback) setFeedback(s.evaluation); else setFeedback(null);
      loadHistory();
      return !s.error;
    } catch (e) {
      setError(e instanceof Error ? e.message : '処理に失敗しました。');
      return false;
    } finally {
      setBusy(false);
      setBusyTarget(null);
      inFlight.current = false;
      finishOperation(operationId);
      setAgentProgress(null);
    }
  }

  const startDiagnostic = async () => {
    if (busy || inFlight.current || !theme.trim()) return;
    const trimmedTheme = theme.trim();
    const tempRootId = 'root_initial';
    const tempSession = {
      session_id: 'pending_initial',
      theme: trimmedTheme,
      domain_context: syllabus || null,
      mode: 'gemini',
      exploration_mode: 'manual',
      manual_flow: 'decomposition_first',
      decomposition_max_depth: null,
      initial_visible_depth: 2,
      initial_generation_complete: false,
      decomposition_depth_reason: null,
      focused_path: [],
      answer_format: 'auto',
      allowed_question_types: ['multiple_choice'],
      reassessment_concept_id: null,
      active_concept_id: null,
      paused_concept_ids: [],
      awaiting_selection: false,
      knowledge_tree: {
        concept_id: tempRootId,
        concept_name: trimmedTheme,
        description: atlas ? `${trimmedTheme}の探索受付を準備しています。` : `${trimmedTheme}の目標・文脈を解析し、第1層の知識マップを構築中...`,
        granularity: 'broad',
        depth: 0,
        parent_concept_id: null,
        parent_ids: [],
        aliases: [],
        merged_from_ids: [],
        source_target_ids: {},
        merged_sources: [],
        prerequisite_concept_ids: [],
        child_candidates: [],
        child_nodes: [],
        assessment_scope: 'direct',
        expansion_kind: 'diagnostic',
        origin: 'generated',
        user_note: null,
        assessment_targets: [],
        terminal_confirmed: false,
        terminal_reason: null,
        expansion_error: null,
        status: 'not_assessed',
      },
      concept_edges: [],
      concept_redirects: {},
      learning_states: {
        [tempRootId]: {
          understanding_score: null,
          diagnostic_confidence: 0,
          questions_answered: 0,
          status: 'not_assessed',
          target_states: {},
          detected_misconceptions: [],
        },
      },
      decomposition_statuses: {
        [tempRootId]: 'generating',
      },
      self_assessments: {},
      understanding_summaries: {},
      next_question: null,
      pending_review: null,
      next_action: null,
      evaluation: null,
      evidence: [],
      question_history: [],
      questions_answered: 0,
      max_total_questions: null,
      complete: false,
      stop_reason: null,
      error: null,
      metrics: {
        display_only_concepts: 0,
        unassessed_concepts: 0,
        written_answers: 0,
        ungradable_answers: 0,
        answer_time_ms: 0,
        assessed_concepts: 0,
        weak_concepts: 0,
      },
      revision: 0,
    } as unknown as Diagnosis;

    // 初期入力直後に最初の中心ノードを即座に表示
    if(atlas){setActivePanel('chat');setChatWide(true);}
    setSession(tempSession);
    setShowSetup(false);
    setSelected(tempRootId);
    setAgentProgress({
      agent: 'DecompositionAgent',
      stage: 'analyzing',
      message: `学習テーマ「${trimmedTheme}」を解析し、周りの概念ノードを生成中...`,
      concept_id: tempRootId,
      concept_name: trimmedTheme,
    });

    const ok = await run((onProg) => apiStream('/sessions', {
      theme: trimmedTheme,
      entry_mode: atlas ? 'map_chat' : 'map',
      domain_context: syllabus || null,
      mode: 'gemini',
      exploration_mode: 'manual',
      manual_flow: 'decomposition_first',
      allowed_question_types: ['multiple_choice'],
    }, onProg), false, false, true);

    if (!ok) {
      setShowSetup(true);
      setSession(null);setActivePanel(null);
    }
  };

  const selectNode = useCallback((id: string) => {
    selectionVersion.current++;
    selectedRef.current=id;
    setSelected(id);
    if(!atlas)setFeedback(null);
    if(atlas){setActivePanel('notebook');setNotebookPage('request');}
  }, [atlas]);


  useEffect(() => {
    if (!session || !selected) return;
    if(session.deleted_concept_ids?.includes(selected)){setSelected(session.knowledge_tree.concept_id);return;}
    const resolved = redirectedId(session,selected);
    if (resolved !== selected) setSelected(resolved);
  }, [session?.concept_redirects, session?.deleted_concept_ids, selected]);

  async function openMap(mapId: string, conceptId?: string) {
    try {
      const next = await api<Diagnosis>(`/sessions/${mapId}`);
      setSession(next); sessionStorage.setItem('diagnostic-session', next.session_id);
      setShowSetup(false);
      const defaultId = initialSelection(next,conceptId);
      setSelected(defaultId);
      setFeedback(null); setError(''); setView('explore'); setDivergenceNode(null);
    } catch (e) { setError(e instanceof Error ? e.message : '知識マップを開けませんでした。'); }
  }

  function createdMap(next: Diagnosis) {
    setSession(next); sessionStorage.setItem('diagnostic-session', next.session_id);
    setShowSetup(false);
    const defaultId = next.next_question?.concept_id ?? next.knowledge_tree.child_nodes[0]?.concept_id ?? next.knowledge_tree.concept_id;
    setSelected(defaultId);
    setFeedback(null); setError(''); setView('explore'); setDivergenceNode(null);
  }

  async function widenKnowledge(mapId: string, conceptId: string, conceptName: string) {
    setConnectionEntry((current)=>({mode:'map',revision:current.revision+1}));
    setView('summary');
    if (wideningRequest.current) return;
    const requestId = crypto.randomUUID();
    wideningRequest.current = requestId;
    setWidening({ requestId, mapId, conceptId, conceptName, status: 'generating', result: null, error: null });
    try {
      const result = await api<DivergenceResult>(`/maps/${mapId}/concepts/${conceptId}/divergence`, {});
      setWidening((current) => (current?.requestId === requestId ? { ...current, status: 'complete', result } : current));
    } catch (e) {
      setWidening((current) => (current?.requestId === requestId ? { ...current, status: 'failed', error: e instanceof Error ? e.message : '候補を生成できませんでした。' } : current));
    } finally {
      if (wideningRequest.current === requestId) wideningRequest.current = null;
    }
  }

  function deletedMap(mapId: string) {
    if (session?.session_id === mapId) {
      setSession(null); setShowSetup(true); setSelected(null);
      sessionStorage.removeItem('diagnostic-session');
    }
    loadHistory();
  }

  async function deleteHistoryItem(e: React.MouseEvent, sessionId: string, targetTheme: string) {
    e.stopPropagation();
    if (!window.confirm(`「${targetTheme || '無題の診断'}」を削除しますか？\n関連する知識マップや回答記録も削除されます。`)) return;
    try {
      await apiMethod(`/maps/${sessionId}`, 'DELETE');
      deletedMap(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました。');
    }
  }

  async function submitAddition() {
    if (!session || !detail || !addedConceptName.trim()) return;
    const added = await run((onProg) => apiStream(`/sessions/${session.session_id}/concepts`, {parent_concept_id:detail.concept_id, concept_name:addedConceptName.trim(), note:addedConceptNote.trim() || null}, onProg), false, true);
    if (added) { setShowAddForm(false); setAddedConceptName(''); setAddedConceptNote(''); }
  }

  function submit(value = answer) {
    if (!session?.next_question || !value.trim() || inFlight.current || (atlas && session.next_question.concept_id!==selected)) return;
    const qConceptId = session.next_question.concept_id;
    setAssessingConceptId(qConceptId);
    const body = {question_id: session.next_question.question_id, answer: value, user_confidence: confidence || null, answer_time_ms: Date.now() - started.current, immediate_feedback: true};
    void run(async (onProg) => {
      try {
        return await apiStream(`/sessions/${session.session_id}/answers`, body, onProg);
      } finally {
        setAssessingConceptId(null);
      }
    }, true);
  }

  async function assessSelected(conceptId: string, level: SurveyLevel) {
    if (!session || inFlight.current) return;
    const requestKey=session.session_id+':'+conceptId;
    const progress=(phase?:'saving'|'expanding'|'question')=>setAssessmentRequests(current=>{
      const next={...current};
      if(phase)next[requestKey]=phase;else delete next[requestKey];
      return next;
    });
    progress('saving');
    if(level==='unsure'){
      setQuestionRequest({sessionId:session.session_id,conceptId});
      if(atlas){setNotebookOpen(true);setNotebookPage('question');}
    }
    try{
      const saved = await run((onProg) => apiStream(`/sessions/${session.session_id}/self-assessment`, {concept_id:conceptId, level}, onProg), false, true, false, conceptId);
      if (!saved) return;
      if(level==='unsure'){
        progress('question');
        await run((onProg) => apiStream(`/sessions/${session.session_id}/select`, {concept_id:conceptId}, onProg),false,true,false,conceptId);
      }else{
        progress('expanding');
        await expandConcept(session.session_id,conceptId);
      }
    }finally{
      progress();
      if(level==='unsure')setQuestionRequest(null);
    }
  }

  function download() {
    if (!session) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], {type:'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = `diagnostic-${session.session_id}.json`; a.click(); URL.revokeObjectURL(url);
  }

  const allNodes = session ? [...new globalThis.Map(flatten(session.knowledge_tree).map(node=>[node.concept_id,node])).values()] : [];
  const visibleIds = session ? (atlas ? atlasVisibleIds(session,expandedIds,selected) : visibleConceptIds(session)) : new Set<string>();
  const nodes = allNodes.filter(node => visibleIds.has(node.concept_id));
  const detail = allNodes.find(n => n.concept_id === selected);
  const assessmentPhase = session && selected ? assessmentRequests[session.session_id+':'+selected] : undefined;
  const assessmentProgress = assessmentPhase ? {conceptId:selected,phase:assessmentPhase} : null;
  const detailChildren = detail ? nodes.filter(n=>detail.child_nodes.some(child=>child.concept_id===n.concept_id)||session?.concept_edges?.some(edge=>edge.relation==='part'&&edge.source===detail.concept_id&&edge.target===n.concept_id)) : [];
  const linkedNodes = detail?.depth === 0 ? session?.knowledge_tree.child_nodes ?? [] : detailChildren;
  const actualChildren = detail ? allNodes.filter(n=>detail.child_nodes.some(c=>c.concept_id===n.concept_id)||session?.concept_edges?.some(e=>e.relation==='part'&&e.source===detail.concept_id&&e.target===n.concept_id)) : [];
  const expansionFailed = (!!detail?.expansion_error || session?.decomposition_statuses?.[detail?.concept_id??'']==='failed') && actualChildren.length === 0;
  const decompositionStatus = detail ? session?.decomposition_statuses?.[detail.concept_id] : undefined;
  const decompositionGenerating = decompositionStatus === 'generating';
  const decompositionFirst = session?.exploration_mode === 'manual' && session.manual_flow === 'decomposition_first';
  const canOfferDecompose = !!(detail && detail.depth > 0 && (atlas ? detailChildren.length === 0 : actualChildren.length === 0) && !(detail.terminal_confirmed && detail.terminal_reason && detail.child_candidates.length === 0));
  const canDecompose = canOfferDecompose && !!detail;
  const canAddConcept = !!(detail && detailChildren.length > 0 && !session?.complete);
  // The API has one active question; the notebook only displays its owning node's state.
  const q = !atlas || session?.next_question?.concept_id===selected ? session?.next_question : null;
  const review = !atlas || session?.pending_review?.concept_id===selected ? session?.pending_review : null;
  const reassessment = !atlas || session?.reassessment_concept_id===selected ? session?.reassessment_concept_id : null;
  const pausedQuestion = atlas && !!selected && !!session?.paused_concept_ids?.includes(selected);
  const questionFlowPending = questionRequest?.sessionId===session?.session_id && questionRequest?.conceptId===selected;
  const nodeBusy = busy && (!atlas || (busyTarget?.sessionId===session?.session_id && busyTarget?.conceptId===selected));
  const expanding = !!session && !!detail && decomposingIds.has(session.session_id+':'+detail.concept_id);
  const showQuestionPage = !!(questionFlowPending || q || feedback || review || reassessment || pausedQuestion);
  useEffect(()=>{
    if(atlas && !showQuestionPage && notebookPage==='question')setNotebookPage('request');
  },[atlas,showQuestionPage,notebookPage]);
  const showQuestion = !!q && (atlas || !decompositionFirst || !!session?.reassessment_concept_id || (q.concept_id === detail?.concept_id && !!session?.self_assessments?.[q.concept_id]));
  const confirmSelectedWithQuestion = () => {
    if (!session || !detail || busy || session.complete) return;
    if(atlas){setNotebookOpen(true);setNotebookPage('question');}
    if(q?.concept_id===detail.concept_id)return;
    setQuestionRequest({sessionId:session.session_id,conceptId:detail.concept_id});
    void run((onProg) => apiStream(`/sessions/${session.session_id}/select`, {concept_id: detail.concept_id}, onProg), false, true)
      .finally(()=>setQuestionRequest(null));
  };
  const current = allNodes.find(n => n.concept_id === q?.concept_id);
  const states = session ? Object.entries(session.learning_states).filter(([id]) => id !== session.knowledge_tree.concept_id && nodes.find(n => n.concept_id === id)?.assessment_scope !== 'covered_by_parent') : [];
  const mastered = states.filter(([id]) => session?.understanding_summaries?.[id]?.level === 'high').length;
  const weak = states.filter(([id]) => session?.understanding_summaries?.[id]?.level === 'low').length;
  const assessmentRemaining = allNodes.filter(n => n.depth > 0 && (session?.learning_states[n.concept_id]?.questions_answered ?? 0) === 0).length;
  const canReassess = !!(session && detail && detail.depth > 0 && (session.learning_states[detail.concept_id]?.questions_answered ?? 0) > 0
    && !session.reassessment_concept_id && q?.concept_id !== detail.concept_id && !session.paused_concept_ids?.includes(detail.concept_id));
  const reassessSelected = () => {
    if (!session || !detail || busy) return;
    if(atlas){setNotebookOpen(true);setNotebookPage('question');}
    setQuestionRequest({sessionId:session.session_id,conceptId:detail.concept_id});
    void run(() => api<Diagnosis>(`/sessions/${session.session_id}/reassess`, {concept_id: detail.concept_id}), false, true)
      .finally(()=>setQuestionRequest(null));
  };
  async function expandConcept(sid: string, originalId: string) {
    const snapshot=sessionRef.current;
    if (!snapshot || snapshot.session_id!==sid) return;
    const cid=redirectedId(snapshot,originalId)!;
    const node=flatten(snapshot.knowledge_tree).find(n=>n.concept_id===cid);
    const requestKey=sid+':'+cid;
    if (!node || node.terminal_confirmed && !node.child_candidates.length && !node.child_nodes.length || expansionRequests.current.has(requestKey)) return;
    const reveal=()=>setExpandedIds(current=>{
      const next=new Set(current).add(cid);
      sessionStorage.setItem('atlas-expanded:'+sid,JSON.stringify([...next]));
      return next;
    });
    if(node.child_nodes.length || snapshot.concept_edges.some(e=>e.relation==='part' && e.source===cid)){reveal();return;}
    const operationId='miner-'+cid;
    expansionRequests.current.add(requestKey);
    setError('');setDecomposingIds(current=>new Set(current).add(requestKey));
    try {
      const next=await apiStream<Diagnosis>('/sessions/'+sid+'/decompose',{concept_id:cid},p=>updateProgress(operationId,p));
      if(sessionRef.current?.session_id!==sid)return;
      setSession(current=>reconcileSession(current,next));
      if(next.error) setError(next.error);else reveal();
      loadHistory();
    } catch(e) {
      if(sessionRef.current?.session_id===sid)setError(e instanceof Error?e.message:'下位項目を展開できませんでした。');
    } finally {
      setDecomposingIds(current=>{const next=new Set(current);next.delete(requestKey);return next;});
      finishOperation(operationId);
      expansionRequests.current.delete(requestKey);
    }
  }
  const decomposeSelected = () => {if(session && detail)void expandConcept(session.session_id,detail.concept_id);};
  const mapSession = session;
  const mapActivity = Object.values(operations).filter((item): item is NonNullable<MapActivity>=>item!==null);

  async function deleteSelectedConcept() {
    if(!session || !detail || detail.depth===0 || busy)return;
    if(!window.confirm(`「${detail.concept_name}」と下位項目をこの地図から削除します。同じ地図の他の親と共有する下位項目も削除します。会話の原文と他の地図は残ります。削除しますか？`))return;
    const sid=session.session_id,cid=detail.concept_id,parent=detail.parent_concept_id??session.knowledge_tree.concept_id;
    await run(async()=>{
      const next=await api<Diagnosis>(`/sessions/${sid}/concepts/delete`,{concept_id:cid});
      if(sessionRef.current?.session_id===sid){
        const removed=new Set(next.deleted_concept_ids??[]);
        if(removed.has(selectedRef.current??''))selectNode(parent);
        setExpandedIds(previous=>{const ids=new Set([...previous].filter(id=>!removed.has(id)));sessionStorage.setItem('atlas-expanded:'+sid,JSON.stringify([...ids]));return ids;});
      }
      return next;
    },false,true);
  }
  const questionPanel = session && (<section className="question-panel panel" aria-busy={nodeBusy}><div className="panel-heading"><div><span className="section-number">02</span><h2>{session.complete && !feedback ? '診断のまとめ' : review && !feedback ? '分析結果を確認' : showQuestion && q ? '理解をたしかめる（4択問題）' : '理解の自己評価'}</h2></div><span>{session.questions_answered} 問回答</span></div><div className="exploration-stage">{session.complete ? "探索終了" : review ? `第${review.layer}層 · あなたの確認を待っています` : feedback ? '回答の対象 · '+(allNodes.find(n=>n.concept_id===feedback.concept_id)?.concept_name??'') : showQuestion && q ? '問題の対象 · '+(current?.concept_name??'') : detail && detail.depth > 0 ? `選択中 · ${detail.concept_name}` : session.awaiting_selection ? '調べたい項目をグラフから選択' : `第${(current?.depth ?? 0) + 1}層を探索中`}</div>
              {reassessment && <div className="reassessment-banner"><span>追加確認 · 過去の回答を含めて再評価します</span><button className="text-button" disabled={busy} onClick={() => void run(() => api<Diagnosis>(`/sessions/${session.session_id}/reassess/cancel`, {}))}>追加確認を中止</button></div>}
              {feedback ? <div className={`feedback ${feedback.correctness}`} aria-live="polite"><span className="question-kicker">ANSWER REVIEW</span><h3>{resultLabels[feedback.correctness]}</h3><div className="feedback-explanation" style={{margin:'14px 0',lineHeight:'1.6'}}><MarkdownContent>{feedback.demonstrated_knowledge.concat(feedback.missing_knowledge).join('\n\n') || 'この回答を診断の根拠に追加しました。'}</MarkdownContent></div><div className="feedback-detail"><span>この回答の評価</span><b>{feedback.correctness === 'ungradable' ? '採点対象外' : understandingLabel[feedback.score >= .8 ? 'high' : feedback.score < .4 ? 'low' : 'medium']}</b><span>採点の確信度</span><b>{certaintyLabel(feedback.evaluation_confidence)}</b></div><p className="small muted">この1問だけで理解状態は確定しません。</p><button className="primary wide" onClick={() => {
                setFeedback(null);
                if (!session.next_question && !session.complete && !session.pending_review) {
                  const visible = visibleConceptIds(session);
                  const all = flatten(session.knowledge_tree);
                  const candidate = all.find(n =>
                    n.depth > 0 &&
                    visible.has(n.concept_id) &&
                    !session.self_assessments?.[n.concept_id]
                  );
                  if (candidate) {
                    setSelected(candidate.concept_id);
                  } else {
                    void run(() => api<Diagnosis>(`/sessions/${session.session_id}`), false, false);
                  }
                }
              }}>{session.complete ? '診断結果を見る' : review ? '分析結果を確認する' : session.awaiting_selection ? '次の項目を選ぶ' : '次へ進む'}<ArrowRight size={17}/></button></div>
              : session.complete ? <div className="summary"><div className="summary-icon"><Check size={24}/></div><h3>{session.stop_reason === 'USER_UNDERSTOOD_GAP' ? '分からない箇所を整理できました。' : '今回の探索結果'}</h3><p>{session.stop_reason === 'USER_UNDERSTOOD_GAP' ? '「何が分からないか分かった」というあなたの確認で終了しました。知識そのものを理解済みと判定したわけではありません。' : session.stop_reason === 'GAP_UNRESOLVED' ? '用意できた項目の探索が終わりました。何が分からないか納得できた状態には、まだ至っていません。' : session.stop_reason === 'COVERAGE_COMPLETE' ? '出題対象の項目を確認し、分解候補を順に探索しました。納得して終了した枝と、これ以上分解できなかった枝は診断記録で確認できます。出題を省略した子は直接採点していません。' : session.stop_reason === 'USER_FINISHED_EXPLORATION' ? '全項目の問題の回答を保存しました。' : session.stop_reason === 'SESSION_LIMIT' ? '以前の設定による質問上限で終了しました。新しい診断には全体の質問上限はありません。' : '今回確認できた内容をマップにまとめました。未確認の項目については判断していません。'}</p><div className="summary-stats"><div><b>{mastered}</b><span>理解度：高</span></div><div><b>{weak}</b><span>理解度：低</span></div></div>{weak > 0 && <p>弱点候補を選ぶと、不足していた点と回答の根拠を確認できます。</p>}<button className="secondary wide" onClick={download}><Download size={16}/>診断記録を保存</button><p className="small muted">問題未回答 {session.metrics.unassessed_concepts} 項目 / 出題省略 {session.metrics.display_only_concepts} 項目 / 採点不能 {session.metrics.ungradable_answers} 問</p></div>
              : review ? <div className="review-body" aria-live="polite"><span className="question-kicker">FINDINGS / 第${review.layer}層</span><h3>何が分からないか、見えてきましたか？</h3><p>{review.summary}</p><div className="review-findings">{[['確認できたこと', review.demonstrated], ['弱点の候補', review.weak_candidates], ['まだ判断できないこと', review.unresolved]].map(([title, items]) => <div key={title as string}><h4>{title as string}</h4>{(items as string[]).length ? <ul>{(items as string[]).map((text,i) => <li key={i}>{text}</li>)}</ul> : <p>今回の回答から該当する点は確認できていません。</p>}</div>)}</div><p className="small muted">診断の確信度 {certaintyLabel(review.diagnostic_confidence)} · 根拠 {review.evidence_ids.length} 件 · 未確認 {review.unassessed_concepts} 項目</p><p className="review-next">{review.next_step}</p><button className="primary wide" disabled={busy} onClick={() => void run((onProg) => apiStream(`/sessions/${session.session_id}/reviews`, {review_id: review!.review_id, decision:'understood_gap'}, onProg))}>{session.exploration_mode === 'comprehensive' ? 'この項目は分かった · 残りの項目へ' : '分からない箇所が分かった · 終了する'}<Check size={16}/></button><button className="secondary wide" disabled={busy} onClick={() => void run((onProg) => apiStream(`/sessions/${session.session_id}/reviews`, {review_id: review!.review_id, decision:'continue_exploring'}, onProg))}>{busy ? <LoaderCircle size={16} className="spin"/> : <ArrowRight size={16}/>}まだ分からない · {review.can_expand ? '次の層へ進む' : '残りの探索を続ける'}</button><p className="small muted">{session.exploration_mode === 'comprehensive' ? 'この項目の探索を終えても、残りの項目を続けます。' : '終了しても未確認の項目や弱点候補を「理解済み」には変更しません。'}</p></div>
              : showQuestion && q ? <form className="question-body" onSubmit={e => {e.preventDefault(); submit();}}><div className="question-meta"><span className="question-kicker">QUESTION {String(session.questions_answered + 1).padStart(2,'0')}</span><span className="format-tag">{typeLabels[q.question_type] ?? '4択問題'}</span></div><div className="concept-breadcrumb"><Target size={14}/>{current?.concept_name}</div><MarkdownContent className="question-markdown">{q.question_text}</MarkdownContent>{q.choices ? <div className="choices">{q.choices.map(c => <button type="button" key={c.choice_id} className={`choice ${answer === c.choice_id ? 'chosen' : ''}`} disabled={busy} onClick={() => setAnswer(c.choice_id)} aria-pressed={answer === c.choice_id}><span className="choice-letter">{c.choice_id === 'yes' ? '○' : c.choice_id === 'no' ? '×' : c.choice_id}</span><MarkdownContent className="choice-markdown" inline>{c.text}</MarkdownContent><span className="choice-radio">{answer === c.choice_id && <span/>}</span></button>)}</div> : <label className="answer-label">あなたの回答<textarea value={answer} onChange={e => setAnswer(e.target.value)} rows={4} maxLength={5000} disabled={busy} placeholder="回答を入力してください" required/></label>}<button className="primary wide" disabled={busy || !answer.trim()}>{nodeBusy ? <><LoaderCircle size={17} className="spin"/>回答を確認しています</> : <>回答して次へ<ArrowRight size={17}/></>}</button>{!q.choices && <button className="skip text-button" type="button" disabled={busy} onClick={() => submit('わからない')}>今は分からない</button>}<p className="question-note">正解することより、今の理解を知ることが大切です。</p></form>
              : nodeBusy ? <div className="retry question-generating" role="status"><LoaderCircle className="spin" size={28}/><h3>{assessingConceptId ? '回答を採点中…' : agentProgress?.agent === 'QuestionAgent' ? '問題を生成中…' : detail ? `「${detail.concept_name}」の処理中…` : 'AIが処理しています…'}</h3><p>{assessingConceptId ? '宝箱は問題の準備状況を示します。回答の採点は別に進めています。' : agentProgress?.message ?? (detail && session.question_statuses?.[detail.concept_id]?.status === 'ready' ? '準備済みの問題を開いています…' : 'サーバーの応答を待っています…')}</p></div>
              : pausedQuestion ? <div className="selection-prompt"><h3>この項目の問題は回答途中です</h3><button className="primary wide" disabled={busy} onClick={confirmSelectedWithQuestion}>この項目の問題を再開する<ArrowRight size={17}/></button></div>
              : atlas ? <div className="selection-prompt"><span className="question-kicker">QUESTION</span><h3>問題を準備しています</h3><p>調査依頼で選んだ確認方法の結果を待っています。</p></div>
              : detail && detail.depth > 0 ? <SelfAssessmentPanel atlas={atlas} node={detail} session={session} busy={busy} processing={nodeBusy} expanding={expanding} questionLoading={questionFlowPending} showDecompose={canOfferDecompose || expanding} canDecompose={canDecompose} decompositionGenerating={decompositionGenerating} questionPending={q?.concept_id === detail.concept_id} canReassess={canReassess} onReassess={reassessSelected} onDecompose={decomposeSelected} onConfirmWithQuestion={confirmSelectedWithQuestion} onSelfAssess={assessSelected}/>
              : detail?.depth === 0 ? <div className="selection-prompt"><span className="question-kicker">MAP SUMMARY</span><h3>開始地点の理解度は集計値です</h3><p>開始地点は直接変更できません。地図上で子項目を選び、自己評価または問題への回答を更新すると、全体の理解度に反映されます。</p></div>
              : <div className="selection-prompt"><span className="question-kicker">EXPLORATION</span><h3>知識項目を選択してください</h3><p>左側の知識マップから確認したい項目を選択すると、自己評価画面が表示されます。</p></div>}
              </section>);
  const detailPanel = session && (<section className="detail-panel panel"><div className="panel-heading"><div><span className="section-number">03</span><h2>診断の根拠</h2></div><div className="detail-actions"><span>説明・確認する能力・回答の記録</span>{canReassess && <button className="secondary" disabled={busy} onClick={reassessSelected}><RotateCcw size={14}/>追加で確認する</button>}{detail && <button className="secondary" type="button" disabled={widening?.status==='generating'} onClick={()=>void widenKnowledge(session.session_id,detail.concept_id,detail.concept_name)}><GitBranch size={14}/>知識を広げる</button>}{detail && detail.depth > 0 && <button className="text-button" type="button" onClick={()=>{if(atlas){setNotebookOpen(true);setNotebookPage('request');}else document.querySelector('.question-panel')?.scrollIntoView({behavior:'smooth'});}}>調査依頼で理解度を確認する</button>}</div></div>{detail && <><NodeDetail node={detail} session={session} onHistory={()=>openMap(session.session_id)}/><ConversationEvidence session={session} conceptId={detail.concept_id}/></>}</section>);
  const legacySelectionPanel = session && (<div className="graph-selection"><div><small>選択中の知識</small><strong>{detail?.concept_name ?? '項目を選んでください'}</strong><p>{detail?.depth === 0 ? 'グラフのノード、または下の一覧から調べたい項目を選択してください。' : detail?.description}</p>{decompositionGenerating && <p className="decomposition-generating" role="status"><LoaderCircle className="spin" size={14}/>下位項目を生成中です。完了すると分解できます。</p>}{expansionFailed && <div className="expansion-warning" role="status"><strong>下位項目を生成できませんでした</strong><p>{detail!.expansion_error}</p><small>「さらに分解」から、この項目の分解だけを再試行できます。</small></div>}</div>{detail && detail.depth > 0 && <div style={{display:'flex',gap:'8px',marginTop:'10px',flexWrap:'wrap'}}><button className="primary" disabled={busy} onClick={() => void run((onProg) => apiStream(`/sessions/${session.session_id}/select`, {concept_id:detail.concept_id}, onProg))}>{busy ? <LoaderCircle className="spin" size={16}/> : <ArrowUpRight size={16}/>} {expansionFailed ? '項目分解を再試行' : 'この項目を深掘り'}</button>{canOfferDecompose && <button className="secondary" disabled={busy || decompositionGenerating} onClick={decomposeSelected} style={{borderColor:'#6366f1',color:'#4338ca',fontWeight:600}}>{decompositionGenerating ? <LoaderCircle className="spin" size={16}/> : <GitBranch size={16}/>} {decompositionGenerating ? '⚡ 分解中…' : '⚡ 分解係で分解'}</button>}</div>}<div className="concept-links">{linkedNodes.map(n => <button key={n.concept_id} disabled={busy} onClick={() => selectNode(n.concept_id)}>{n.concept_name}<ArrowUpRight size={12}/></button>)}</div>{canAddConcept && <div className="add-concept-area"><button className="secondary" type="button" disabled={busy} aria-expanded={showAddForm} onClick={() => setShowAddForm(!showAddForm)}>不足している項目を追加</button>{showAddForm && <form className="add-concept-form" onSubmit={e => {e.preventDefault(); void submitAddition();}}><label>追加したい項目名（仮）<input value={addedConceptName} onChange={e => setAddedConceptName(e.target.value)} maxLength={120} required placeholder="例：接線の方程式"/></label><label>補足・追加したい理由 <span>任意</span><textarea value={addedConceptNote} onChange={e => setAddedConceptNote(e.target.value)} maxLength={1000} rows={3} placeholder="既存の項目にない内容や、確認したい能力"/></label><p>{session.mode === 'gemini' ? '入力した名前と補足、親・既存の子をもとに、AIが項目名と確認する能力を整えます。問題はまだ作りません。' : 'デモでは入力した項目名をそのまま使います。問題はまだ作りません。'}</p><div><button className="primary" disabled={busy || !addedConceptName.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <GitBranch size={16}/>}項目を追加</button><button className="text-button" type="button" disabled={busy} onClick={() => setShowAddForm(false)}>キャンセル</button></div></form>}</div>}{busy && <p role="status" className="small muted">準備しています…</p>}</div>);
  const selectionPanel = session && <div className="graph-selection">
    <div><small>選択中の知識</small><strong>{detail?.concept_name ?? '地図から項目を選んでください'}</strong></div>
    {detail && assessmentProgress?.conceptId===detail.concept_id && <div className="request-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={16}/><div><strong>{assessmentProgress.phase==='saving'?'理解度を保存しています…':assessmentProgress.phase==='question'?'問題を開いています…':decompositionStatus==='ready'?'下位項目を地図に反映しています…':'下位項目を準備しています…'}</strong><p>{assessmentProgress.phase==='saving'?'選んだ自己評価を記録しています。':assessmentProgress.phase==='question'?'問題・回答ページで続けられるようにしています。':agentProgress?.concept_id===detail.concept_id?agentProgress.message:'保存した理解度を反映し、下位項目を展開しています。'}</p></div></div>}
    {detail && expanding && !decompositionGenerating && assessmentProgress?.conceptId!==detail.concept_id && <p role="status">下位項目を地図に反映しています…</p>}
    {detail && detail.depth>0 && <>
      <SelfAssessmentPanel atlas={atlas} key={detail.concept_id} node={detail} session={session} busy={busy} processing={nodeBusy} expanding={expanding} questionLoading={questionFlowPending} showDecompose={canOfferDecompose || expanding} canDecompose={canDecompose} decompositionGenerating={decompositionGenerating} questionPending={q?.concept_id===detail.concept_id} canReassess={canReassess} onReassess={reassessSelected} onDecompose={decomposeSelected} onConfirmWithQuestion={confirmSelectedWithQuestion} onSelfAssess={assessSelected}/>
      {expansionFailed && <p className="expansion-warning" role="status">下位項目を展開できませんでした。展開ボタンから再試行できます。</p>}
      {canReassess && <button className="secondary" disabled={busy} onClick={reassessSelected}>追加の問題で確認する</button>}
      {session.question_statuses?.[detail.concept_id]?.status==='failed' && <p className="expansion-warning">問題の準備に失敗しました。「問題で理解度を確認する」から再試行できます。下位項目の展開も利用できます。</p>}
      {session.deleted_concept_ids && <button className="text-button" disabled={busy} onClick={()=>void deleteSelectedConcept()}><Trash2 size={14}/>この項目と配下を削除</button>}
    </>}
    <details className="atlas-branch-links"><summary>つながる項目 · {linkedNodes?.length ?? 0}</summary><div className="concept-links">{linkedNodes?.map(n=><button key={n.concept_id} onClick={()=>selectNode(n.concept_id)}>{n.concept_name}<ArrowUpRight size={12}/></button>)}</div></details>
    {detail && !session.complete && <div className="add-concept-area"><button className="secondary" disabled={busy} onClick={()=>setShowAddForm(v=>!v)}>不足している項目を追加</button>{showAddForm && <form className="add-concept-form" onSubmit={e=>{e.preventDefault();void submitAddition();}}><label>追加したい項目名<input required maxLength={120} value={addedConceptName} onChange={e=>setAddedConceptName(e.target.value)}/></label><label>補足・追加したい理由<textarea maxLength={1000} rows={3} value={addedConceptNote} onChange={e=>setAddedConceptNote(e.target.value)}/></label><button className="primary" disabled={busy||!addedConceptName.trim()}>項目を追加</button></form>}</div>}
  </div>;
  const chatWindow = session && <AtlasChat key={session.session_id} open={activePanel==='chat'} wide={chatWide} onWide={()=>setChatWide(v=>!v)} onClose={()=>setActivePanel(null)} session={session} selected={selected} onSession={applyChatSession}/>;
  const notebook = session && <AtlasNotebook open={notebookOpen} onClose={()=>setNotebookOpen(false)} page={notebookPage} onPage={setNotebookPage} showQuestionPage={showQuestionPage} request={selectionPanel} question={questionPanel} record={detailPanel}/>;
  return <div className={`app-shell ${atlas ? `live-atlas ${session && !showSetup ? 'atlas-exploring' : ''}` : ''} ${sidebarOpen ? 'has-sidebar' : 'sidebar-closed'}`}>
    {user && <aside className={`history-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
      <div className="sidebar-top">
        <div className="sidebar-title">
          <Clock size={16}/>
          <span>診断履歴</span>
          {history.length > 0 && <span className="history-count">{history.length}</span>}
        </div>
        <button className="new-session-button" onClick={startNewSession} title="新しい診断をはじめる">
          <Plus size={15}/>
          <span>新しい診断</span>
        </button>
      </div>
      <div className="history-list">
        {history.length === 0 ? (
          <div className="history-empty">
            <p>診断履歴はありません。<br/>新しいテーマを入力して診断を開始してください。</p>
          </div>
        ) : (
          history.map(item => {
            const isActive = session?.session_id === item.session_id;
            const dateStr = item.created_at ? new Date(item.created_at).toLocaleDateString('ja-JP', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
            return (
              <div
                key={item.session_id}
                className={`history-card ${isActive ? 'active' : ''}`}
                onClick={() => void selectSession(item.session_id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void selectSession(item.session_id); } }}
              >
                <div className="history-card-main">
                  <strong className="history-card-theme">{item.theme || '無題の診断'}</strong>
                  <button
                    className="history-card-delete"
                    type="button"
                    title="この診断履歴を削除"
                    aria-label={`${item.theme || '診断'}を削除`}
                    disabled={busy}
                    onClick={(e) => void deleteHistoryItem(e, item.session_id, item.theme)}
                  >
                    <Trash2 size={13}/>
                  </button>
                </div>
                {dateStr && <span className="history-card-date">{dateStr}</span>}
              </div>
            );
          })
        )}
      </div>
    </aside>}

    <div className="app-main-layout">
      <header className="topbar">
        <div className="topbar-left">
          {user && <button className="icon-toggle-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title={sidebarOpen ? "履歴を閉じる" : "履歴を開く"} aria-label="履歴サイドバー切替">
            <Menu size={18}/>
          </button>}
          <a className="brand brand-wordmark" href="/" onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();startNewSession();}} aria-label="IntellectusMap ホーム"><span className="brand-wordmark-image"><img src="/intellectus-map-wordmark-clear-e.png" alt="IntellectusMap" width="2172" height="724"/></span></a>
        </div>
        <nav className="main-nav" aria-label="主要メニュー">
          <button className={view==='explore'?'active':''} onClick={()=>setView('explore')}>探索</button>
          <button className={view==='maps'?'active':''} onClick={()=>{setMapDetailId(null);setView('maps');}}>深堀マップ一覧</button>
          <button className={view==='summary'?'active':''} onClick={()=>{setConnectionEntry((current)=>({mode:'list',revision:current.revision+1}));setView('summary');}}>繋がりMAP一覧</button>
          <button className={view==='nodes'?'active':''} onClick={()=>setView('nodes')}>知識ノード一覧</button>
          <UserManual />
        </nav>
        <div className="top-right">{!atlas && <a className="secondary atlas-view-link" href="/">地図の画面へ</a>}
          {user ? (
            <div className="user-profile">
              {user.picture ? <img src={user.picture} alt="" className="user-avatar"/> : <User size={15}/>}
              <span className="user-name">{user.name ?? user.email ?? 'Googleユーザー'}</span>
              <button className="text-button logout-btn" onClick={logout} title="ログアウト"><LogOut size={13}/>ログアウト</button>
            </div>
          ) : (
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
              <button className="primary login-btn" onClick={promptGoogleLogin}><LogIn size={13}/>Googleでログイン</button>
            </div>
          )}
        </div>
      </header>

      <main>
        {!user ? <LoginGate onLogin={profile=>{startNewSession();setUser(profile);}}/> : view === 'maps' ? <MapManager key={mapDetailId ?? 'all'} initialMapId={mapDetailId} onOpenMap={openMap} onDeleted={deletedMap}/> : view === 'summary' ? <UnderstandingPage onOpenMap={openMap} widening={widening} onWiden={widenKnowledge} atlas={atlas} entry={connectionEntry}/> : view === 'nodes' ? <KnowledgeNodeList onOpenMap={openMap}/> : <>
          {error && <div className="error-banner" role="alert"><span>{error}</span>{session && !showAddForm && <button className="text-button" disabled={busy} onClick={() => void run((onProg) => decompositionFirst && expansionFailed && detail ? apiStream(`/sessions/${session.session_id}/decompose`, {concept_id:detail.concept_id}, onProg) : api<Diagnosis>(`/sessions/${session.session_id}`), false, true)}>再試行</button>}<button aria-label="エラーを閉じる" onClick={() => setError('')}><X size={17}/></button></div>}
          {!atlas && <AgentStatusBadge progress={agentProgress} />}
          {!atlas && session && (
            <div className="agent-live-monitor" role="region" aria-label="エージェント稼働モニター">
              <div className="agent-live-group">
                <span className="agent-live-title">
                  <span className="agent-pulse-dot" style={{backgroundColor: '#6366f1'}}/>
                  <strong>⚡ 分割エージェント (DecompositionAgent)</strong>:
                </span>
                {allNodes.filter(n => session.decomposition_statuses?.[n.concept_id] === 'generating').length > 0 ? (
                  <span className="agent-live-active">
                    並行生成中: {allNodes.filter(n => session.decomposition_statuses?.[n.concept_id] === 'generating').map(n => n.concept_name).join(', ')}
                  </span>
                ) : (
                  <span className="agent-live-idle">
                    待機中（ノードを選択して「⚡ 分割エージェントで分解」を実行可能）
                  </span>
                )}
              </div>
              {session.next_question && (
                <div className="agent-live-group">
                  <span className="agent-live-title">
                    <span className="agent-pulse-dot" style={{backgroundColor: '#3b82f6'}}/>
                    <strong>🤖 問題検討エージェント (QuestionAgent)</strong>:
                  </span>
                  <span className="agent-live-active">
                    出題対象: {allNodes.find(n => n.concept_id === session.next_question?.concept_id)?.concept_name ?? ''}
                  </span>
                </div>
              )}
            </div>
          )}
          {showSetup && atlas ? <AtlasStart theme={theme} onTheme={setTheme} syllabus={syllabus} onSyllabus={setSyllabus} busy={busy} ready={ready} configurationError={configurationError} onStart={()=>void startDiagnostic()}/> : showSetup ? <section className="setup panel">
            <div className="section-label"><span>01</span> 学びたいテーマ</div>
            <form onSubmit={e => {e.preventDefault(); void startDiagnostic();}}>
              <p className="coverage-hint">AIが知識マップを自動生成し、4択問題を出題します。回答していくことで理解度と知識ギャップが即座に可視化されます。</p>
              <p className="fixed-question-formats">確認問題は4択形式で出題します。</p>
              <div className="setup-fields">
                <label>テーマ<input value={theme} onChange={e => setTheme(e.target.value)} maxLength={300} required placeholder="例：機械学習、コンピュータネットワーク、統計学"/></label>
                <button className="primary start" disabled={busy || !ready || !theme.trim()}>{busy ? <LoaderCircle className="spin" size={18}/> : <Sparkles size={17}/>}診断をはじめる<ArrowRight size={17}/></button>
                <label className="syllabus-field">テーマの詳細情報 <span>任意</span><textarea value={syllabus} onChange={e => setSyllabus(e.target.value)} maxLength={12000} rows={7} placeholder={"例：\n対象レベル：大学教養レベル\n学びたい範囲：基本概念、主要なアルゴリズム\n特に確認したいこと：適用条件と限界\n除外したい内容：高度な数学的証明"}/><small><span>テーマの背景、対象レベル、含めたい内容や除外したい内容を入力できます。レベルを指定しても、基礎項目を理解済みとはみなしません。</span><span>{syllabus.length.toLocaleString()} / 12,000</span></small></label>
              </div>
            </form>
            <div className="setup-foot"><span>テーマを分解 → 4択問題に回答 → 知識ギャップを即時可視化</span><span>{ready ? 'テーマと回答がGeminiに送信されます。' : configurationError || 'Geminiの設定を確認しています。'}</span></div>
          </section> : null}
          {!session ? (!atlas && <Welcome busy={busy}/>) : <>
            <div className="session-bar panel" hidden={atlas}>
              <div><span className="live-dot"/><strong>{session.theme}</strong><span className="mode-tag">{session.mode}</span></div>
              <div style={{display:'flex',alignItems:'center',gap:'10px'}}><small className="muted">ID: {session.session_id}</small></div>
            </div>
            <div hidden={atlas} className="exploration-method-tabs" role="group" aria-label="理解の確認方法"><button className={assessmentMethod==='manual'?'active':''} onClick={()=>setAssessmentMethod('manual')}>自己評価・問題</button><button className={assessmentMethod==='chat'?'active':''} onClick={()=>setAssessmentMethod('chat')}>会話で確認</button></div>
            {atlas ? <div className="workspace atlas-workspace"><section className="map-panel panel"><div className="panel-heading"><div><Map size={18}/><h2>{session.theme}</h2></div><div><span>{nodes.length - 1} の知識項目</span><button className="text-button" onClick={download}><Download size={14}/>保存</button></div></div><LiveAtlasMap key={session.session_id} session={mapSession!} selected={selected} onSelect={selectNode} activity={mapActivity} visibleIds={visibleIds} notebook={notebook} chat={chatWindow} chatOpen={activePanel==='chat'} onToggleChat={()=>{setChatWide(false);setActivePanel('chat');}} notebookOpen={notebookOpen} onToggleNotebook={()=>setNotebookOpen(true)}/></section></div> : (<div className={`workspace ${nodes.length > 12 ? 'large-map' : ''}`}>
              <section className="map-panel panel"><div className="panel-heading"><div><Map size={18}/><h2>理解のマップ</h2></div><div style={{display:'flex',alignItems:'center',gap:'10px'}}><span>{nodes.length - 1} の知識項目</span><button className="text-button" onClick={download} title="診断記録を保存" style={{padding:'2px 6px',fontSize:'11px'}}><Download size={13}/>保存</button></div></div><div className="map-toolbar"><span>知識をつないで、関心をたどる</span><div><span className="legend-dot mastered"/>高<span className="legend-dot weak"/>低<span className="legend-dot not_assessed"/>未判定</div></div><div className="flow-wrap"><KnowledgeTree key={session.session_id} session={session} selected={selected} onSelect={selectNode} activeAgentProgress={agentProgress} assessingConceptId={assessingConceptId}/></div>{session.exploration_mode === 'manual' && !session.complete && legacySelectionPanel}<div className="map-footer"><span>回答済み {session.questions_answered} 問{assessmentRemaining > 0 && <> · 未回答 {assessmentRemaining} 項目</>}</span><span>ノード外周をドラッグで配置 / スクロールで拡大縮小</span></div></section>
              {assessmentMethod === 'chat' ? <ChatPanel key={session.session_id} session={session} selected={selected} onSession={applyChatSession}/> : questionPanel}
            </div>)}
          {!atlas && detailPanel}
          </>}
          <footer><span>IntellectusMap</span><span>診断は限られた回答からの推定です。能力そのものを評価するものではありません。</span></footer>
        </>}
      </main>

      {view === 'explore' && session && divergenceNode && <DivergenceDrawer key={`${session.session_id}:${divergenceNode.concept_id}`} mapId={session.session_id} node={divergenceNode} onClose={()=>setDivergenceNode(null)} onCreated={createdMap}/>}

      <TestAuthModal
        isOpen={showTestAuthModal}
        onClose={() => setShowTestAuthModal(false)}
        onSuccess={(authedUser) => {
          setUser(authedUser);
          setShowTestAuthModal(false);
        }}
      />
    </div>
  </div>;
}

function TestAuthModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: UserProfile) => void;
}) {
  const [username, setUsername] = useState('tester');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('ユーザー名とパスワードを入力してください。');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const user = await loginWithBasicAuth(username.trim(), password);
      onSuccess(user);
    } catch (err: any) {
      setError(err?.message || '認証に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
      }}
    >
      <div
        className="modal-card panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '420px',
          padding: '28px',
          borderRadius: '16px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.2)',
          background: 'var(--bg-surface, #ffffff)',
          border: '1px solid var(--border-color, #e2e8f0)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                backgroundColor: '#e0e7ff',
                color: '#4338ca',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Lock size={20} />
            </div>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>テストモード（Basic認証）</h3>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={onClose}
            aria-label="閉じる"
            style={{ padding: '4px', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--text-muted, #64748b)', margin: '0 0 20px 0', lineHeight: 1.5 }}>
          テストモードの無制限アクセスを防ぐため、Basic認証が必要です。設定されたユーザー名とパスワードを入力してください。
        </p>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              color: '#b91c1c',
              fontSize: '13px',
              marginBottom: '16px',
              fontWeight: 500,
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
              ユーザー名
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="tester"
              autoComplete="username"
              required
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                border: '1px solid var(--border-color, #cbd5e1)',
                background: 'var(--bg-input, #f8fafc)',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
              パスワード
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="パスワードを入力"
              autoFocus
              autoComplete="current-password"
              required
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                border: '1px solid var(--border-color, #cbd5e1)',
                background: 'var(--bg-input, #f8fafc)',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={loading}
              style={{ padding: '9px 16px', borderRadius: '8px', fontSize: '14px' }}
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="primary"
              disabled={loading}
              style={{
                padding: '9px 20px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              {loading ? <LoaderCircle size={16} className="spin" /> : <Lock size={16} />}
              認証してテスト開始
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LoginGate({onLogin}:{onLogin:(user:UserProfile)=>void}) {
  return <div className="login-gate panel">
    <div className="login-gate-icon"><GitBranch size={38}/></div>
    <h2>IntellectusMapへログイン</h2>
    <JudgeLogin onLogin={onLogin}/>
    <p>通常のご利用はGoogleアカウントでもログインできます。</p>
    <div className="login-gate-action" style={{display: 'flex', justifyContent: 'center', margin: '24px 0 16px'}}>
      <div id="google-login-btn-container" style={{minHeight: '44px'}}></div>
    </div>
    <div className="login-gate-foot">
      <span>審査員アカウントの探索データは、通常ユーザーと分離して保存されます。</span>
    </div>
  </div>;
}

function Welcome({busy}: {busy: boolean}) { return <div className="welcome panel"><div className="welcome-illustration"><span className="orbit one"/><span className="orbit two"/><div className="welcome-center">{busy ? <LoaderCircle size={30} className="spin"/> : <GitBranch size={32}/>}</div><span className="float-label first"><span className="status-dot mastered"/>理解済（青）</span><span className="float-label second"><span className="status-dot weak"/>要復習（赤）</span></div><div><div className="eyebrow">AUTOMATED KNOWLEDGE MAPPING</div><h2>{busy ? 'テーマを知識の地図にしています…' : '問いに答えるだけで、理解の輪郭が見える。'}</h2><p>テーマを入力するとAIが知識マップを自動生成。<br/>4択問題に答えていくと、誤答や理解の浅い分野を自動で深掘りします。</p><div className="steps"><span>01 テーマを入力</span><ArrowRight size={14}/><span>02 自動出題に回答</span><ArrowRight size={14}/><span>03 理解度が可視化</span></div></div></div>; }

function SelfAssessmentPanel({
  atlas = false,
  node,
  session,
  busy,
  processing = busy,
  expanding = false,
  questionLoading = false,
  showDecompose,
  canDecompose,
  decompositionGenerating,
  questionPending,
  canReassess,
  onReassess,
  onDecompose,
  onConfirmWithQuestion,
  onSelfAssess,
}: {
  atlas?: boolean;
  node: KnowledgeNode;
  session: Diagnosis;
  busy: boolean;
  processing?: boolean;
  expanding?: boolean;
  questionLoading?: boolean;
  showDecompose: boolean;
  canDecompose: boolean;
  decompositionGenerating: boolean;
  questionPending: boolean;
  canReassess?: boolean;
  onReassess?: () => void;
  onDecompose: () => void;
  onConfirmWithQuestion: () => void;
  onSelfAssess: (conceptId: string, level: SurveyLevel) => void;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [node.concept_id]);
  const survey = session.self_assessments?.[node.concept_id];
  const summary = session.understanding_summaries?.[node.concept_id];
  const chatAssessed = !!session.conversation_assessed_concept_ids?.includes(node.concept_id);
  const hasQuestionEvidence = session.evidence.some(e => e.concept_id === node.concept_id && e.correctness !== 'ungradable');
  const options: { level: SurveyLevel; label: string }[] = [
    { level: 'high', label: atlas ? '理解できている' : '理解している' },
    { level: 'medium', label: atlas ? '一部理解できている' : 'あいまい' },
    { level: 'low', label: atlas ? '理解できていない' : '分からない' },
    { level: 'unsure', label: atlas ? '問題で理解度を確認する' : '自分では判断できない（問題で確認）' },
  ];
  const selectedLabel = survey?.level === 'unsure' && !atlas ? '自分では判断できない' : options.find(option => option.level === survey?.level)?.label;

  return (
    <div className="self-assessment-panel selection-prompt">
      <span className="question-kicker">SELF ASSESSMENT</span>
      <h3>この項目の自己評価 <span>{survey ? '回答済み' : chatAssessed ? '任意（会話で確認済み）' : '必須'}</span></h3>
      <div className="concept-breadcrumb"><Target size={14} />{node.concept_name}</div>
      <p className="assessment-description">{node.description}</p>
      <div className="assessment-context">
        <h4>確認する能力</h4>
        <ul>{node.assessment_targets.map(target => <li key={target.target_id}>{target.description}</li>)}</ul>
      </div>
      {!survey || editing ? (
        <>
          <p className="assessment-instruction">説明と確認する能力を読んで、今の理解に最も近いものを選んでください。</p>
          <div className="survey-options">
            {options.map(({ level, label }) => (
              <button
                key={level}
                type="button"
                className={survey?.level === level ? 'chosen' : ''}
                aria-pressed={survey?.level === level}
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  onSelfAssess(node.concept_id, level);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="survey-result">
          <div><small>あなたの自己評価</small><strong>{selectedLabel}</strong></div>
          <button className="text-button" type="button" disabled={busy} onClick={() => setEditing(true)}>回答を変更</button>
        </div>
      )}
      {(survey || showDecompose || canReassess) && (
        <div className="survey-followups">
          {survey && (
            <button
              className="secondary"
              type="button"
              disabled={busy || questionLoading || (!!session.reassessment_concept_id && !questionPending)}
              aria-busy={questionLoading}
              onClick={onConfirmWithQuestion}
            >
              {questionLoading && <LoaderCircle className="spin" size={16}/>}
              {questionLoading ? '問題を開いています…' : questionPending ? '表示中の問題に回答する' : '問題で理解度を確認する'}
            </button>
          )}
          {showDecompose && (
            <button
              className="secondary"
              type="button"
              disabled={!canDecompose || expanding}
              aria-busy={expanding}
              onClick={onDecompose}
              style={{ borderColor: '#6366f1', color: '#4338ca', fontWeight: 600 }}
            >
              {expanding || decompositionGenerating ? <LoaderCircle className="spin" size={16} /> : <GitBranch size={16} />}
              {expanding ? '下位項目を展開しています…' : decompositionGenerating ? '準備ができ次第、下位項目を展開' : '問題を飛ばして下位項目を展開'}
            </button>
          )}
          {!survey && !canReassess && <p className="small muted">問題に回答しなくても、下位項目を展開できます。</p>}
        </div>
      )}
      {processing && <p className="small muted" role="status">処理しています…</p>}
      {survey?.level === 'unsure' && !hasQuestionEvidence && !busy && (
        <p className="small muted">問題での確認が必要です。問題が表示されない場合は「問題で理解度を確認する」を押してください。</p>
      )}
      {survey?.level === 'unsure' && hasQuestionEvidence && (
        <p className="small muted">問題の回答を診断の根拠に保存しました。</p>
      )}
      {summary?.source === 'descendants' && (
        <p className="small muted">推定理解度は直下 {summary.assessed} / {summary.total} 項目の結果を優先して集計します。</p>
      )}
      {summary?.source === 'self_report' && summary.missing > 0 && (
        <p className="small muted">直下に未判定の項目があるため、現在はこの項目の自己評価を暫定表示しています。</p>
      )}
    </div>
  );
}

function NodeDetail({node, session, onHistory}: {node: KnowledgeNode; session: Diagnosis; onHistory:()=>void}) {
  const s = session.learning_states[node.concept_id];
  const summary = session.understanding_summaries?.[node.concept_id];
  const covered = node.assessment_scope === 'covered_by_parent';
  const hasChildren = node.child_nodes.length > 0 || session.concept_edges?.some(edge => edge.source === node.concept_id && edge.relation === 'part');
  const terminal = node.depth > 0 && node.terminal_confirmed && node.child_candidates.length === 0 && !hasChildren;
  const expansionFailed = !!node.expansion_error && !hasChildren;
  const parent = flatten(session.knowledge_tree).find(n => n.child_nodes.some(child => child.concept_id === node.concept_id));
  const evidence = session.evidence.filter(e => e.concept_id === node.concept_id);
  const sharedFrom = session.canonical_refs?.[node.concept_id]?.other_map_titles ?? [];
  const sharedEvidence = evidence.some(item => item.origin_map_id && item.origin_map_id !== session.session_id);
  const confidenceSourceLabel = summary?.provisional ? '会話由来の暫定値（理解は未検証）' : summary?.source === 'descendants'
    ? '下位項目を集計'
    : summary?.source === 'question' ? '問題の回答'
    : summary?.source === 'conversation' ? '会話の根拠'
    : summary?.source === 'mixed' ? '問題と会話の根拠'
    : summary?.source === 'self_report' ? '自己評価'
    : summary?.source === 'needs_question' ? '問題での確認待ち'
    : '未回答';
  return <div className="detail-content"><div className="detail-overview"><span className={`status-pill ${summary?.level ?? 'unknown'}`}>{`理解度：${understandingLabel[summary?.level ?? 'unknown']}`}</span><h3>{node.concept_name}</h3>{sharedEvidence && <div className="shared-map-note">✓ 別の知識マップで確認済み · 確認元：{sharedFrom.join('・') || '別の知識マップ'} <button className="text-button" onClick={onHistory}>回答履歴を見る</button></div>}{node.aliases?.length > 0 && <p className="small muted">別名：{node.aliases.join("・")}</p>}{node.parent_ids?.length > 1 && <p className="small muted">複数の項目からつながる知識</p>}{node.origin === 'user_added' && <span className="user-added-badge">ユーザーが追加</span>}<p>{node.description}</p>{node.origin === 'user_added' && node.user_note && <p className="user-added-note">追加時の補足：{node.user_note}</p>}{node.merged_sources?.filter(source => source.origin === 'user_added' && source.user_note && source.concept.concept_id !== node.concept_id).map(source => <p className="user-added-note" key={source.concept.concept_id}>「{source.concept.concept_name}」の追加時の補足：{source.user_note}</p>)}{expansionFailed && <div className="expansion-warning"><strong>下位項目を生成できませんでした</strong><p>{node.expansion_error}</p><small>末端と判定された状態ではありません。再試行できます。</small></div>}{terminal && <div className="terminal-explanation"><strong>AIがこれ以上の分解候補はないと判定</strong><p>{node.terminal_reason ?? 'これ以上細分化しても、理解度診断に有効な独立した項目にならないと判定されました。'}</p><small>AIによる推定であり、学習要項上の絶対的な末端を保証するものではありません。</small></div>}{covered && <p className="covered-explanation">親項目「{parent?.concept_name}」の診断で出題を省略した項目です。子項目を直接採点した結果ではありません。</p>}<div className="score-pair"><div><span>推定理解度</span><strong>{understandingLabel[summary?.level ?? 'unknown']}</strong></div><div><span>判定の信頼度</span><strong>{understandingLabel[summary?.confidence_level ?? 'unknown']}</strong></div><div><span>問題の回答</span><strong>{summary?.question_answers ?? 0}<small> 問</small></strong></div></div><div className="record-source-counts"><span>自己評価 {summary?.survey_answers??0} 件</span><span>会話の根拠 {summary?.conversation_answers??0} 件</span></div><p className="small muted">根拠：{confidenceSourceLabel}{hasChildren && <span> · 回答数はこの項目と配下の合計</span>}</p>{node.depth === 0 && <p className="small muted">開始地点は直接変更できません。各子項目に推定値がそろうと、配下の重複を除いた評価値の平均を表示します。</p>}</div><div className="target-detail"><h4>確認する能力</h4>{node.assessment_targets.map(t => {const ts = s.target_states[t.target_id]; return <div className="target-row" key={t.target_id}><span className={`status-dot ${ts.status}`}/><div><span>{t.description}</span><small>{covered ? '親の結果により出題省略 · 直接評価なし' : `${statusLabel[ts.status]} · 確信度 ${certaintyLabel(ts.diagnostic_confidence)}`}</small></div><b>{ts.understanding_score == null ? '未判定' : understandingLabel[ts.understanding_score >= .8 ? 'high' : ts.understanding_score < .4 ? 'low' : 'medium']}</b></div>;})}{s.detected_misconceptions.length > 0 && <div className="issue"><h4>誤解の可能性</h4>{s.detected_misconceptions.map((m,i) => <p key={i}>{m.description}</p>)}<small>誤答に対応する候補です。断定ではありません。</small></div>}</div><div className="evidence-detail"><h4>回答の記録 <span>{evidence.length}</span></h4>{evidence.length === 0 ? <p className="empty-evidence">{covered ? 'この子項目は出題を省略しています。親項目の診断根拠を参照してください。' : 'まだ回答の根拠がありません。診断を進めるとここに記録されます。'}</p> : <div className="evidence-list">{evidence.map(e => {const q = session.question_history.find(q => q.question_id === e.question_id);return <details key={e.evidence_id}><summary><span className={`evidence-dot ${e.correctness}`}/><MarkdownContent className="evidence-question" inline>{q?.question_text ?? ''}</MarkdownContent><ChevronDown size={14}/></summary><div className="evidence-answer"><b>回答：</b><MarkdownContent inline>{q?.choices?.find(c => c.choice_id === e.user_answer)?.text ?? e.user_answer}</MarkdownContent></div><div className="evidence-answer"><b>参考解答：</b><MarkdownContent inline>{q?.choices?.find(c => c.choice_id === q.expected_answer?.[0])?.text ?? q?.expected_answer?.join(' / ') ?? ''}</MarkdownContent></div><MarkdownContent className="evidence-explanation">{q?.answer_explanation ?? ''}</MarkdownContent><small>{resultLabels[e.correctness]} · 採点確信度 {certaintyLabel(e.evaluation_confidence)}</small></details>;})}</div>}</div></div>;
}
