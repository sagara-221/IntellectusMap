// ==============================================================================
// 知識ノード横断一覧・検索コンポーネント (KnowledgeNodeList)
// 用途: 全知識マップにまたがる概念ノードの検索・理解度フィルタリング・詳細モーダル表示
// ==============================================================================
import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, LoaderCircle, Search } from 'lucide-react';
import { api } from './api';
import MarkdownContent from './MarkdownContent';

// 理解度レベル・フィルタ・ソート順型定義
type Level = 'high' | 'medium' | 'low' | 'unknown' | 'mixed';
type LevelFilter = Level | 'all';
type Sort = 'priority' | 'understood' | 'name' | 'recent' | 'questions';

interface MapOption { map_id: string; title: string }
interface MapResult {
  map_id: string;
  map_title: string;
  concept_id: string;
  concept_name: string;
  description: string;
  path: string[];
  level: Exclude<Level, 'mixed'>;
  confidence_level: Exclude<Level, 'mixed'>;
  source: string;
  direct_question_answers: number;
  shared_question_answers: number;
  self_assessment: string | null;
  last_assessed_at: string | null;
}

interface NodeRow {
  canonical_id: string;
  map_id: string;
  concept_id: string;
  concept_name: string;
  description: string;
  path: string[];
  aliases: string[];
  map_count: number;
  assessed_map_count: number;
  level: Level;
  confidence_level: Level;
  source: string;
  question_answers: number;
  last_assessed_at: string | null;
  map_results: MapResult[];
}
interface NodeListResponse {
  items: NodeRow[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<LevelFilter, number>;
  maps: MapOption[];
}
interface QuestionHistory {
  at: string;
  question: string;
  user_answer: string;
  correct_answer: string;
  answer_explanation: string;
  result: string;
  target: string;
  demonstrated_knowledge: string[];
  missing_knowledge: string[];
  origin_map_id: string | null;
}
interface NodeDetail {
  map_id: string;
  map_title: string;
  concept_id: string;
  concept_name: string;
  description: string;
  path: string[];
  assessment_targets: {target_id: string; description: string}[];
  understanding: {level: Exclude<Level, 'mixed'>; confidence_level: Exclude<Level, 'mixed'>; source: string};
  self_assessment: {level: string; answered_at: string} | null;
  history: QuestionHistory[];
}

const levelLabel: Record<Level, string> = {
  high: '高', medium: '中', low: '低', unknown: '未判定', mixed: 'マップで差あり',
};
const sourceLabel: Record<string, string> = {
  question: '問題の回答', descendants: '下位項目',
  needs_question: '問題で確認待ち', not_answered: '未回答', multiple_maps: 'マップ別',
};
const resultLabel: Record<string, string> = {
  correct: '正解', partially_correct: '一部正解', incorrect: '誤答', ungradable: '判定できず',
};
const filters: {value: LevelFilter; label: string}[] = [
  {value: 'all', label: 'すべて'}, {value: 'low', label: '理解度：低'},
  {value: 'mixed', label: 'マップで差あり'}, {value: 'unknown', label: '未判定'},
  {value: 'medium', label: '理解度：中'}, {value: 'high', label: '理解度：高'},
];
const date = (value: string | null) => value ? new Date(value).toLocaleString('ja-JP') : '—';

export default function KnowledgeNodeList({onOpenMap}: {onOpenMap: (mapId: string, conceptId?: string) => void}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [mapId, setMapId] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [sort, setSort] = useState<Sort>('priority');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<NodeListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<NodeRow | null>(null);
  const [occurrence, setOccurrence] = useState<MapResult | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({q: search, level, sort, page: String(page), page_size: '50'});
    if (mapId) params.set('map_id', mapId);
    setLoading(true);
    setError('');
    void api<NodeListResponse>(`/knowledge-nodes?${params}`).then(result => {
      if (active) setData(result);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '知識ノードを読み込めませんでした。');
    }).finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [search, mapId, level, sort, page]);

  useEffect(() => {
    if (!occurrence) {setDetail(null); return;}
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    void api<NodeDetail>(`/knowledge-nodes/${encodeURIComponent(occurrence.map_id)}/${encodeURIComponent(occurrence.concept_id)}`)
      .then(result => {if (active) setDetail(result);})
      .catch(cause => {if (active) setError(cause instanceof Error ? cause.message : '回答履歴を読み込めませんでした。');})
      .finally(() => {if (active) setDetailLoading(false);});
    return () => {active = false;};
  }, [occurrence]);

  function clearSelection() {setSelected(null); setOccurrence(null); setDetail(null);}
  function choose(row: NodeRow) {
    setSelected(row);
    setOccurrence(row.map_results.find(item => item.map_id === mapId) ??
      row.map_results.find(item => item.map_id === row.map_id) ?? row.map_results[0]);
  }
  const pages = Math.ceil((data?.total ?? 0) / 50);

  return <div className="map-page knowledge-page">
    <div className="page-title"><div><span className="eyebrow">KNOWLEDGE NODES</span><h1>知識ノード一覧</h1><p>すべての知識マップを横断し、理解の状態と問題の回答履歴を確認できます。</p></div></div>
    <p className="node-list-note">同一と判定された知識だけをまとめています。理解度は下位項目の結果を優先した推定です。マップで絞ると、そのマップでの判定と問題回答数を表示します。</p>
    <div className="panel node-list-controls">
      <label className="node-search"><span>知識・マップを検索</span><div><Search size={16}/><input value={query} onChange={event => {setQuery(event.target.value); setPage(1); clearSelection();}} placeholder="ノード名、説明、マップ名"/></div></label>
      <label><span>知識マップ</span><select value={mapId} onChange={event => {setMapId(event.target.value); setPage(1); clearSelection();}}><option value="">すべてのマップ</option>{data?.maps.map(item => <option key={item.map_id} value={item.map_id}>{item.title}</option>)}</select></label>
      <label><span>並び順</span><select value={sort} onChange={event => {setSort(event.target.value as Sort); setPage(1); clearSelection();}}><option value="priority">理解度：低・差あり・未判定から</option><option value="understood">理解度：高から</option><option value="recent">最近回答した順</option><option value="questions">問題回答が多い順</option><option value="name">ノード名順</option></select></label>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!data && loading ? <p className="node-loading" role="status"><LoaderCircle className="spin" size={18}/>知識ノードを読み込んでいます…</p>
      : !data || data.maps.length === 0 ? <p className="panel empty-map">まだ知識マップがありません。探索画面でテーマを入力すると、ここに知識ノードが並びます。</p>
      : <>
        <div className="node-level-filters" aria-label="理解度で絞り込み">{filters.map(item => <button key={item.value} className={level === item.value ? 'active' : ''} aria-pressed={level === item.value} onClick={() => {setLevel(item.value); setPage(1); clearSelection();}}>{item.label}<b>{data.counts[item.value] ?? 0}</b></button>)}</div>
        <div className="node-list-layout">
          <section className="panel node-list-area" aria-busy={loading}>
            <div className="node-list-heading"><h2>知識ノード <span>{data.total}件</span></h2>{loading && <LoaderCircle className="spin" size={16}/>}</div>
            {data.items.length === 0 ? <p className="node-empty">条件に合う知識ノードがありません。</p> : <>
              <div className="node-table-head"><span>知識</span><span>推定理解度</span><span>信頼度</span><span>マップ</span><span>問題回答</span></div>
              <div className="node-list">{data.items.map(row => <button key={row.canonical_id} className={`node-row ${selected?.canonical_id === row.canonical_id ? 'selected' : ''}`} aria-label={`${row.concept_name}の詳細`} onClick={() => choose(row)}><span className="node-row-name"><strong>{row.concept_name}</strong><small className="node-row-path">{row.path.slice(0, -1).join(' › ')}</small>{row.aliases.length > 0 && <small>別名：{row.aliases.join('・')}</small>}<small>{row.description}</small></span><span><small className="node-mobile-label">推定理解度</small><b className={`node-level level-${row.level}`}>{levelLabel[row.level]}</b></span><span><small className="node-mobile-label">信頼度</small><b className={`node-level level-${row.confidence_level}`}>{levelLabel[row.confidence_level]}</b></span><span><small className="node-mobile-label">マップ</small>{row.map_count} マップ<small>{row.assessed_map_count} マップで判定</small></span><span><small className="node-mobile-label">問題回答</small>{row.question_answers} 問<small>{row.last_assessed_at ? date(row.last_assessed_at) : '回答なし'}</small></span></button>)}</div>
            </>}
            {pages > 1 && <div className="node-pagination"><button className="secondary" disabled={page <= 1 || loading} onClick={() => {setPage(page - 1); clearSelection();}}>前へ</button><span>{page} / {pages} ページ</span><button className="secondary" disabled={page >= pages || loading} onClick={() => {setPage(page + 1); clearSelection();}}>次へ</button></div>}
          </section>
          <aside className="panel node-inspector">{!selected ? <div className="node-inspector-empty"><BookOpen size={28}/><h2>知識ノードを選んでください</h2><p>マップごとの理解度と、問題の回答履歴を確認できます。</p></div> : <>
            <h2>{selected.concept_name}</h2>{selected.aliases.length > 0 && <p className="small muted">別名：{selected.aliases.join('・')}</p>}<p className="node-inspector-description">{selected.description}</p>
            <div className="node-inspector-summary"><span>推定理解度 <b className={`node-level level-${selected.level}`}>{levelLabel[selected.level]}</b></span><span>信頼度 <b className={`node-level level-${selected.confidence_level}`}>{levelLabel[selected.confidence_level]}</b></span><span>対象マップ <b>{selected.map_count}</b></span></div>
            <h3>マップごとの結果</h3><div className="node-map-results">{selected.map_results.map(item => <button key={`${item.map_id}:${item.concept_id}`} className={occurrence?.map_id === item.map_id && occurrence.concept_id === item.concept_id ? 'active' : ''} onClick={() => setOccurrence(item)}><strong>{item.map_title}</strong><small>{item.path.join(' › ')}</small><span>理解度 {levelLabel[item.level]} · 信頼度 {levelLabel[item.confidence_level]}</span><small>問題 {item.direct_question_answers} 問{item.shared_question_answers > 0 ? `（共有 ${item.shared_question_answers} 問）` : ''} · {sourceLabel[item.source] ?? item.source}</small></button>)}</div>
            {detailLoading ? <p className="node-loading" role="status"><LoaderCircle className="spin" size={16}/>回答履歴を読み込んでいます…</p> : detail && <div className="node-inspector-detail"><p className="node-path">{detail.path.join(' › ')}</p><p>{detail.description}</p><h3>確認する能力</h3><ul>{detail.assessment_targets.map(target => <li key={target.target_id}>{target.description}</li>)}</ul><button className="secondary" onClick={() => onOpenMap(detail.map_id, detail.concept_id)}>このマップで開く <ArrowRight size={14}/></button><h3>問題の回答履歴 <span>{detail.history.length} 問</span></h3>{detail.history.length === 0 ? <p className="muted">この知識への問題回答はまだありません。</p> : <div className="node-question-history">{detail.history.map((entry, index) => <article key={`${entry.at}-${index}`}><div><time>{date(entry.at)}</time><span className={`node-result result-${entry.result}`}>{resultLabel[entry.result] ?? entry.result}</span></div>{entry.origin_map_id && entry.origin_map_id !== detail.map_id && <small>回答元：{data.maps.find(item => item.map_id === entry.origin_map_id)?.title ?? '別の知識マップ'}</small>}<h4>問題</h4><MarkdownContent className="node-history-markdown">{entry.question}</MarkdownContent><p><b>あなたの回答：</b>{entry.user_answer}</p><p><b>正答：</b>{entry.correct_answer}</p>{entry.answer_explanation && <><h4>解説</h4><MarkdownContent className="node-history-markdown">{entry.answer_explanation}</MarkdownContent></>}{entry.target && <small>確認する能力：{entry.target}</small>}{entry.demonstrated_knowledge.length > 0 && <p><b>確認できたこと：</b>{entry.demonstrated_knowledge.join('、')}</p>}{entry.missing_knowledge.length > 0 && <p><b>確認したい点：</b>{entry.missing_knowledge.join('、')}</p>}</article>)}</div>}</div>}
          </>}</aside>
        </div>
      </>}
  </div>;
}
