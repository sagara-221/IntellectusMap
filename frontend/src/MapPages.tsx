// ==============================================================================
// 知識マップ一覧 & 繋がりMAP (MapPages)
// 用途: 深堀マップ一覧（検索・ソート・編集・削除）、繋がりMAP（放射状グラフ・未探索候補プレビュー・新規マップ派生）
// ==============================================================================
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Background, ControlButton, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useNodesState, useReactFlow, useStore, ViewportPortal, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { ArrowLeft, ArrowRight, Compass, GitBranch, LoaderCircle, MapPin, Scan, Sparkles, Trash2, X } from 'lucide-react';
import { api, apiMethod, apiStream, type AgentProgress } from './api';
import { AgentStatusBadge } from './AgentStatusBadge';
import AgentTaskIcon from './AgentTaskIcon';
import ListToolbar, { type ListCondition } from './ListToolbar';
import Miner from './PixelAgent';
import { contourPaths, useMapForces } from './map-geometry';
import { type Diagnosis, type KnowledgeNode, understandingLabel } from './types';

interface Origin {
  source_map_id: string;
  source_concept_id: string;
  source_map_title?: string;
  source_concept_name?: string;
  category: string;
  relation: string;
  reason: string;
}
interface MapStats {
  explored_concepts: number;
  diagnosed_concepts: number;
  question_answers: number;
  survey_answers: number;
  weak_concepts: number;
}
interface MapItem {
  map_id: string;
  lineage_id: string;
  title: string;
  scope: string | null;
  updated_at: string;
  origin: Origin | null;
  stats: MapStats;
}
interface Lineage {
  lineage_id: string;
  root_map_id: string;
  title: string;
  map_ids: string[];
}
interface MapRelation extends Origin {
  target_map_id: string;
}
interface Candidate {
  id: string;
  name: string;
  category: string;
  relation: string;
  reason: string;
}
interface SavedCandidate extends Candidate {
  source_map_id: string;
  source_concept_id: string;
  source_concept_name: string;
  target_map_id: string | null;
}
interface MapList {
  maps: MapItem[];
  lineages: Lineage[];
  relations: MapRelation[];
  candidates?: SavedCandidate[];
}
interface HistoryItem {
  type: 'question' | 'self_assessment';
  at: string;
  concept_id: string;
  concept_name: string;
  question?: string;
  user_answer?: string;
  result?: string;
  target?: string;
  level?: string;
  understanding_before?: number | null;
  understanding_after?: number | null;
  origin_map_id?: string | null;
}
interface MapDetail extends MapItem {
  session: Diagnosis;
  history: HistoryItem[];
}
interface ConceptSummary {
  concept_id: string;
  concept_name: string;
  depth: number;
  status: string;
  level: 'high' | 'medium' | 'low' | 'unknown';
  confidence_level: 'high' | 'medium' | 'low' | 'unknown';
  source: string;
  question_answers: number;
  survey_answers: number;
  other_map_ids: string[];
}
export interface DivergenceResult {
  source_map_id: string;
  source_concept_id: string;
  source_concept_name: string;
  candidates: Candidate[];
}
export interface WideningState {
  requestId: string;
  mapId: string;
  conceptId: string;
  conceptName: string;
  status: 'generating' | 'complete' | 'failed';
  result: DivergenceResult | null;
  error: string | null;
}

const mapSortOptions = [
  { value: 'recent', label: '最近更新した順' },
  { value: 'name', label: 'マップ名順' },
  { value: 'diagnosed', label: '理解度の確認が多い順' },
  { value: 'weak', label: '理解度「低」が多い順' },
];
const mapFilterOptions = [
  { value: 'all', label: 'すべて' },
  { value: 'assessed', label: '理解度を確認済み' },
  { value: 'weak', label: '理解度「低」がある' },
];
const mapNameOrder = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

const date = (value: string) => new Date(value).toLocaleString('ja-JP');
const resultLabel: Record<string, string> = { correct: '正解', partially_correct: '一部正解', incorrect: '誤答', ungradable: '判定できず' };
const surveyLabel: Record<string, string> = { high: '理解している', medium: 'あいまい', low: '分からない', unsure: '自分では判断できない' };
const scoreLabel = (value: number | null | undefined) => (value == null ? '未判定' : understandingLabel[value >= 0.8 ? 'high' : value < 0.4 ? 'low' : 'medium']);
const connectionTitle = (title: string) => {
  const initialism = title.match(/^([A-Z]{2,}[A-Z0-9+.#-]*)(?=[\u3040-\u30ff\u3400-\u9fff])/);
  return `${initialism?.[1] ?? title}の繋がりMAP`;
};
const edgeRelationLabel = (value: string) => {
  const relation = value.trim();
  const concise = relation.match(/を(.+?)するために関連する$/)?.[1] ?? relation;
  return concise.length > 18 ? `${concise.slice(0, 17)}…` : concise;
};

function Stats({ stats }: { stats: MapStats }) {
  return (
    <div className="map-stats">
      <span>探索済み <b>{stats.explored_concepts}</b></span>
      <span>理解度確認済み <b>{stats.diagnosed_concepts}</b></span>
      <span>問題回答 <b>{stats.question_answers}</b></span>
      <span>自己評価 <b>{stats.survey_answers}</b></span>
      <span>理解度：低 <b>{stats.weak_concepts}</b></span>
    </div>
  );
}

function History({ items, maps, currentMapId }: { items: HistoryItem[]; maps: MapItem[]; currentMapId: string }) {
  const currentMapTitle = maps.find((item) => item.map_id === currentMapId)?.title ?? '深掘りマップ';
  return (
    <div className="map-history">
      {items.length === 0 ? (
        <p className="muted">回答はまだありません。</p>
      ) : (
        items.map((item, index) => (
          <article key={`${item.type}-${item.concept_id}-${index}`} className="history-item">
            <div>
              <span className="history-badge">{item.type === 'question' ? '問題' : '自己評価'}</span>
              <time>{date(item.at)}</time>
            </div>
            <p className="muted">深掘りマップ：{currentMapTitle}</p>
            <h4>{item.concept_name}</h4>
            {item.origin_map_id && item.origin_map_id !== currentMapId && (
              <p className="muted">確認元：{maps.find((map) => map.map_id === item.origin_map_id)?.title ?? '別の深掘りマップ'}</p>
            )}
            {item.type === 'question' ? (
              <>
                <p><b>問題：</b>{item.question}</p>
                <p><b>回答：</b>{item.user_answer}</p>
                <p><b>採点：</b>{resultLabel[item.result ?? ''] ?? item.result}　<b>確認Target：</b>{item.target || '—'}</p>
                <p>理解度の変化：{scoreLabel(item.understanding_before)} → {scoreLabel(item.understanding_after)}</p>
              </>
            ) : (
              <p>回答：{surveyLabel[item.level ?? ''] ?? item.level}</p>
            )}
          </article>
        ))
      )}
    </div>
  );
}

type ConnectionPoint = { x: number; y: number };
type ConnectionActivity = { id: string; targetId: string; kind: 'survey' | 'build' };

function ConnectionWorker({ activity, position, campRef }: { activity: ConnectionActivity; position: ConnectionPoint; campRef: RefObject<HTMLDivElement | null> }) {
  const { screenToFlowPosition } = useReactFlow();
  const [departure, setDeparture] = useState<ConnectionPoint | null>(null);
  const [arrived, setArrived] = useState(false);
  const target = { x: position.x + (activity.kind === 'build' && position.x > 0 ? -118 : 96), y: position.y - 58 };

  useLayoutEffect(() => {
    const camp = campRef.current?.getBoundingClientRect();
    const origin = camp ? screenToFlowPosition({ x: camp.left + 36, y: camp.top + 32 }) : { x: target.x - 120, y: target.y - 80 };
    setDeparture({ x: origin.x - target.x, y: origin.y - target.y });
    const timer = window.setTimeout(() => setArrived(true), 1050);
    return () => window.clearTimeout(timer);
    // The departure is captured once for each operation; camera movement then carries the worker with the graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.id, activity.targetId]);

  return <ViewportPortal>
    {departure && <div
      className={`connection-worker ${arrived ? 'task-' + (activity.kind === 'survey' ? 'inspect' : 'build') : 'travelling'}`}
      data-connection-agent={activity.kind}
      style={{ left: target.x, top: target.y, '--route-x': `${departure.x}px`, '--route-y': `${departure.y}px` } as CSSProperties}
      aria-label={activity.kind === 'survey' ? '探索係が候補を調査中' : '分解係がMAPを作成中'}
    >
      <div className="connection-worker-travel">
        <Miner state={arrived ? 'work' : 'walk'} tint={activity.kind === 'survey' ? '#67a3a5' : '#d49a54'} tool={activity.kind === 'survey' ? 'lens' : 'pick'} />
        {arrived && <AgentTaskIcon action={activity.kind === 'survey' ? 'inspect' : 'build'} />}
      </div>
      {arrived && <span className="connection-worker-label">{activity.kind === 'survey' ? '探索係：候補を調査中' : '分解係：MAPを作成中'}</span>}
    </div>}
  </ViewportPortal>;
}
function ConnectionGlyph({ kind }: { kind: 'root' | 'map' | 'candidate' }) {
  return <svg className={`connection-node-icon icon-${kind}`} viewBox="0 0 32 32" shapeRendering="crispEdges" aria-hidden="true">
    {kind === 'root' ? <>
      <path fill="#416c73" d="M14 1h4v5h-4zM14 26h4v5h-4zM1 14h5v4H1zM26 14h5v4h-5z" />
      <path fill="#dbad5d" d="m16 5 4 7 7 4-7 4-4 7-4-7-7-4 7-4z" />
      <path fill="#fff2c4" d="m16 10 2 4 4 2-4 2-2 4-2-4-4-2 4-2z" />
      <path fill="#345968" d="M14 14h4v4h-4z" />
    </> : kind === 'map' ? <>
      <path fill="#668b86" d="M3 25h26v4H3z" />
      <path fill="#3e7180" d="M7 13h18v13H7z" />
      <path fill="#cfab69" d="M5 13 15 5h3l9 8v3H5z" />
      <path fill="#f6e9bc" d="M11 17h4v5h-4zM19 17h4v5h-4z" />
      <path fill="#284e5c" d="M15 20h4v6h-4z" />
      <path fill="#a87945" d="M24 5h2v9h-2zM26 5h5v5h-5z" />
    </> : <>
      <path fill="#9bb3a3" d="M3 25h26v3H3zM7 21h18v4H7z" />
      <path fill="#bc925b" d="M14 7h2v17h-2z" />
      <path fill="#dbad6a" d="M16 7h12v8H16z" />
      <path fill="#fff4d0" d="M20 9h4v2h-4zM21 12h2v2h-2z" />
      <path fill="#537982" d="M9 19h5v3H9z" />
    </>}
  </svg>;
}
function ConnectionNode({ data }: NodeProps<Node<{ label: ReactNode }>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <svg className="connection-island" viewBox="0 0 96 64" shapeRendering="crispEdges" aria-hidden="true">
        <path className="island-water" d="M20 19h48v4h12v7h8v17h-9v7H64v5H24v-5H9v-8H3V32h8v-8h9z" />
        <path fill="#d2f0e5" d="M23 22h43v4h12v7h6v11h-9v7H62v4H26v-5H13v-7H7v-9h9v-7h7z" />
        <path fill="#ba9865" d="M24 24h41v4h11v8h5v7h-9v7H27v-4H16v-9h8z" />
        <path fill="#f4dc9c" d="M24 20h39v5h11v8h5v8H68v6H28v-4H16V32h8z" />
        <path className="island-grass" d="M30 17h26v5h9v7h7v8H60v5H31v-5H22v-9h8z" />
        <path className="island-meadow" d="M32 20h21v5h9v5H49v6H29v-7h3z" />
        <path fill="#547b55" d="M24 27h4v4h-4zM58 31h5v4h-5zM36 37h4v3h-4z" />
        <path fill="#fff0c3" d="M21 36h5v3h-5zM57 44h7v2h-7z" />
        <path className="island-dock" fill="#9e7046" d="M67 37h16v4H67zM74 35h2v9h-2zM80 35h2v9h-2z" />
      </svg>
      {data.label}
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
const connectionNodeTypes = { connection: ConnectionNode };

// New nodes start outward from their source. The force simulation then determines their final positions.
function radialConnections(rootId: string, items: { id: string; parentId: string | null }[]) {
  const children = new Map(items.map((item) => [item.id, [] as string[]]));
  const pending = new Map(items.filter((item) => item.id !== rootId).map((item) => [item.id, item.parentId]));
  const connect = (id: string) => {
    for (const [child, parent] of pending) {
      if (parent !== id) continue;
      pending.delete(child);
      children.get(id)!.push(child);
      connect(child);
    }
  };
  connect(rootId);
  while (pending.size) {
    const id = pending.keys().next().value!;
    pending.delete(id);
    children.get(rootId)!.push(id);
    connect(id);
  }
  const weights = new Map<string, number>();
  const weigh = (id: string): number => {
    const weight = Math.max(1, children.get(id)!.reduce((sum, child) => sum + weigh(child), 0));
    weights.set(id, weight);
    return weight;
  };
  weigh(rootId);
  const polar = new Map<string, { depth: number; angle: number }>();
  const assign = (id: string, depth: number, start: number, span: number) => {
    polar.set(id, { depth, angle: start + span / 2 });
    let next = start;
    for (const child of children.get(id)!) {
      const childSpan = (span * weights.get(child)!) / weights.get(id)!;
      assign(child, depth + 1, next, childSpan);
      next += childSpan;
    }
  };
  assign(rootId, 0, -Math.PI / 2 - Math.PI / weights.get(rootId)!, Math.PI * 2);
  const rings = new Map<number, number[]>();
  for (const { depth, angle } of polar.values()) if (depth > 0) rings.set(depth, [...(rings.get(depth) ?? []), angle]);
  const radii = new Map([[0, 0]]);
  for (const [depth, angles] of [...rings].sort(([a], [b]) => a - b)) {
    angles.sort((a, b) => a - b);
    const gaps = angles.map((angle, index) => (angles[(index + 1) % angles.length] + (index === angles.length - 1 ? Math.PI * 2 : 0)) - angle);
    const minGap = Math.min(...gaps);
    const radius = angles.length > 1 ? 245 / (2 * Math.sin(minGap / 2)) : 0;
    radii.set(depth, Math.max((radii.get(depth - 1) ?? 0) + 275, radius));
  }
  return new Map([...polar].map(([id, { depth, angle }]) => [id, { x: Math.cos(angle) * radii.get(depth)!, y: Math.sin(angle) * radii.get(depth)! }]));
}

// Use the live deep-map physics at a larger scale for map titles and relation labels.
const connectionScale = 1.5;
function useConnectionForces(baseNodes: Node[], baseEdges: Edge[], root?: string) {
  const topology = baseNodes.map(node => node.id).join('|') + ':' + baseEdges.map(edge => edge.id).join('|');
  const initial = useMemo(() => baseNodes.map(node => ({id: node.id,
    x: node.position.x / connectionScale + 500, y: node.position.y / connectionScale + 350})), [topology]);
  const links = useMemo(() => baseEdges.map(({source, target}) => ({source, target})), [topology]);
  const {points, move, settled} = useMapForces(initial, links, 0, root);
  const positions = useMemo(() => new Map(points.map(point => [point.id, {
    x: (point.x - 500) * connectionScale, y: (point.y - 350) * connectionScale,
  }])), [points]);
  const contour = useMemo(() => {
    const extent = Math.max(1, Math.sqrt(points.length / 6) * .85);
    return {paths: contourPaths(points, links, root), bounds: {
      left: -500 * extent * connectionScale, top: -350 * extent * connectionScale,
      width: 1000 * extent * connectionScale, height: 700 * extent * connectionScale,
    }};
  }, [points, links, root]);
  return {positions, settled, contour, move: (id: string, position: ConnectionPoint, end = false) =>
    move(id, position.x / connectionScale + 500, position.y / connectionScale + 350, end)};
}

function ConnectionViewport({ layoutKey, roots, focus, wideArea, manualCamera }: { layoutKey: string; roots: ConnectionPoint[]; focus: ConnectionPoint | null; wideArea: boolean; manualCamera: RefObject<boolean> }) {
  const initialized = useStore((state) => state.nodeLookup.size > 0 && [...state.nodeLookup.values()].every((node) => !!node.measured.width && !!node.measured.height && !!node.internals.handleBounds));
  const { getNodes, getNodesBounds, setCenter, fitView, viewportInitialized } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const center = (overview = false) => {
    if (!viewportInitialized || !width || !height) return;
    if (wideArea) {
      if (overview || !focus) void fitView({ padding: 0.15, maxZoom: 1.15 });
      else void setCenter(focus.x, focus.y, { zoom: Math.max(0.72, Math.min(width / 1050, height / 720, 0.95)) });
      return;
    }
    if (!initialized) return;
    if (roots.length !== 1) {
      void fitView({ padding: 0.25, maxZoom: 1.2 });
      return;
    }
    const root = roots[0];
    const bounds = getNodesBounds(getNodes());
    const halfWidth = Math.max(root.x - bounds.x, bounds.x + bounds.width - root.x, 140);
    const halfHeight = Math.max(root.y - bounds.y, bounds.y + bounds.height - root.y, 100);
    const zoom = Math.min(width / (halfWidth * 2 * 1.25), height / (halfHeight * 2 * 1.25), 1.2);
    void setCenter(root.x, root.y, { zoom });
  };
  useEffect(() => {
    if (manualCamera.current) return;
    const frame = requestAnimationFrame(() => { if (!manualCamera.current) center(); });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, viewportInitialized, layoutKey, wideArea, width, height]);
  return <Controls showFitView={false} showInteractive={false}><ControlButton onClick={() => center(wideArea)} title="Fit View" aria-label="Fit View"><Scan size={15}/></ControlButton></Controls>;
}

function MapConnections({
  data,
  lineageId,
  selectedMapId,
  onSelect,
  highlightedIds = [],
  wideArea = false,
  activity = null,
}: {
  data: MapList;
  lineageId: string;
  selectedMapId: string | null;
  onSelect: (id: string) => void;
  highlightedIds?: string[];
  wideArea?: boolean;
  activity?: ConnectionActivity | null;
}) {
  const campRef = useRef<HTMLDivElement>(null);
  const manualCamera = useRef(false);
  const { nodes: seedNodes, edges: seedEdges, roots } = useMemo(() => {
    const maps = data.maps.filter((item) => !lineageId || item.lineage_id === lineageId);
    const ids = new Set(maps.map((item) => item.map_id));
    const candidates = (data.candidates ?? []).filter((item) => ids.has(item.source_map_id) && !ids.has(item.target_map_id ?? ''));
    const relations = data.relations.filter((relation) => ids.has(relation.source_map_id) && ids.has(relation.target_map_id));
    const nodes: Node[] = [];
    const roots: ConnectionPoint[] = [];
    const lineages = data.lineages.filter((item) => !lineageId || item.lineage_id === lineageId);
    for (const [groupIndex, lineage] of lineages.entries()) {
      const groupMaps = maps.filter((item) => item.lineage_id === lineage.lineage_id);
      if (!groupMaps.length) continue;
      const groupIds = new Set(groupMaps.map((item) => item.map_id));
      const groupCandidates = candidates.filter((item) => groupIds.has(item.source_map_id));
      const rootId = groupIds.has(lineage.root_map_id)
        ? lineage.root_map_id
        : groupMaps.find((item) => !relations.some((relation) => relation.target_map_id === item.map_id))?.map_id ?? groupMaps[0].map_id;
      const positions = radialConnections(rootId, [
        ...groupMaps.map((item) => ({
          id: item.map_id,
          parentId: relations.find((relation) => relation.target_map_id === item.map_id && groupIds.has(relation.source_map_id))?.source_map_id ?? null,
        })),
        ...groupCandidates.map((item) => ({ id: item.id, parentId: item.source_map_id })),
      ]);
      const offsetY = groupIndex * 1600;
      roots.push({ x: 0, y: offsetY });
      const positionAt = (id: string) => {
        const point = positions.get(id)!;
        return { x: point.x, y: point.y + offsetY };
      };
      for (const item of groupMaps) {
        nodes.push({
          id: item.map_id,
          type: 'connection',
          ...(wideArea ? { initialWidth: 178, initialHeight: 64 } : {}),
          position: positionAt(item.map_id),
          className: `${item.map_id === rootId ? 'connection-root' : ''} ${item.map_id === selectedMapId ? 'connection-map-selected' : ''}`,
          data: {
            label: (
              <div className="map-graph-node">
                <ConnectionGlyph kind={item.map_id === rootId ? 'root' : 'map'} />
                <strong>{item.title}</strong>
                <small>{item.map_id === rootId ? '起点' : '深掘りMAP'} · {item.stats.explored_concepts}項目</small>
              </div>
            ),
          },
        });
      }
      for (const candidate of groupCandidates) {
        nodes.push({
          id: candidate.id,
          type: 'connection',
          ...(wideArea ? { initialWidth: 178, initialHeight: 64 } : {}),
          position: positionAt(candidate.id),
          className: `connection-candidate ${candidate.id === selectedMapId ? 'connection-map-selected' : ''} ${highlightedIds.includes(candidate.id) ? 'connection-new-candidate' : ''}`,
          data: {
            label: (
              <div className="map-graph-node">
                <ConnectionGlyph kind="candidate" />
                <strong>{candidate.name}</strong>
                <small>{highlightedIds.includes(candidate.id) ? '新しい候補' : '未探索'}</small>
              </div>
            ),
          },
        });
      }
    }
    const edges: Edge[] = relations.map((relation) => ({
      id: relation.source_map_id + '-' + relation.target_map_id,
      source: relation.source_map_id,
      target: relation.target_map_id,
      type: 'straight',
      label: edgeRelationLabel(relation.relation) || relation.category,
      ariaLabel: relation.relation,
      labelStyle: { fill: '#315b63', fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: '#f4f9f2', stroke: '#a8c1bd', strokeWidth: 1 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#567e88' },
      style: { stroke: '#567e88', strokeWidth: 2.2 },
    }));
    edges.push(
      ...candidates.map((candidate) => ({
        id: `candidate-edge-${candidate.id}`,
        source: candidate.source_map_id,
        target: candidate.id,
        type: 'straight',
        label: edgeRelationLabel(candidate.relation) || candidate.category,
        ariaLabel: candidate.relation,
        labelStyle: { fill: '#785434', fontSize: 10, fontWeight: 700 },
        labelBgStyle: { fill: '#fff8e9', stroke: '#d6ba8d', strokeWidth: 1 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#a07752' },
        style: { stroke: '#a07752', strokeWidth: 1.8, strokeDasharray: '6 5' },
      }))
    );
    return { nodes, edges, roots };
  }, [data, lineageId, selectedMapId, highlightedIds, wideArea]);
  const layoutKey = seedNodes.map((node) => node.id).join('|') + ':' + seedEdges.map((edge) => `${edge.source}>${edge.target}`).join('|');
  const rootId = seedNodes.find((node) => node.className?.includes('connection-root'))?.id;
  const { positions: forcePositions, settled, move, contour } = useConnectionForces(seedNodes, seedEdges, rootId);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const dragging = useRef<string | null>(null);
  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]));
      return seedNodes.map((seed) => {
        const old = previous.get(seed.id);
        const position = dragging.current === seed.id && old ? old.position : forcePositions.get(seed.id) ?? old?.position ?? seed.position;
        return { ...old, ...seed, position };
      });
    });
  }, [seedNodes, forcePositions, setNodes]);
  const selected = (settled ? nodes : seedNodes).find((node) => node.id === selectedMapId);
  const selectedCandidate = (data.candidates ?? []).find((candidate) => candidate.id === selectedMapId);
  const focusNodes = settled ? nodes : seedNodes;
  const focus = (selectedCandidate ? focusNodes.find((node) => node.id === selectedCandidate.source_map_id) : selected)?.position ?? roots[0] ?? null;
  const workingNode = activity ? nodes.find((node) => node.id === activity.targetId) : null;
  return (
    <div className="map-connections" aria-label="深掘りマップのつながり" data-layout={settled ? 'settled' : 'settling'}>
      {wideArea && <div className="connection-camp" ref={campRef} aria-label="繋がりMAP調査隊">
        <span className="connection-camp-title">繋がり調査隊</span>
        <span className="connection-camp-slot">{!workingNode && <Miner tint="#67a3a5" tool="lens" />}{workingNode && <span className="connection-camp-away">出動中</span>}</span>
      </div>}
      <ReactFlow
        nodes={nodes}
        edges={seedEdges}
        nodeTypes={connectionNodeTypes}
        nodeOrigin={[0.5, 0.5]}
        minZoom={0.15}
        maxZoom={3}
        zoomOnDoubleClick={false}
        onMoveStart={(event) => { if (event) manualCamera.current = true; }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeDragStart={(_, node) => { manualCamera.current = true; dragging.current = node.id; }}
        onNodeDrag={(_, node) => move(node.id, node.position)}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => { dragging.current = null; move(node.id, node.position, true); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            const nodeId = (event.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
            if (!nodeId) return;
            event.preventDefault();
            onSelect(nodeId);
          }
        }}
        nodesDraggable
        panOnDrag
        nodesConnectable={false}
      >
        <ConnectionViewport layoutKey={layoutKey} roots={roots} focus={focus} wideArea={wideArea} manualCamera={manualCamera} />
        <Background gap={32} color="#bbd0cb" size={1} />
        {wideArea && <ViewportPortal><svg className="connection-contours" data-contours={contour.paths.length} aria-hidden="true"
          style={{left:contour.bounds.left,top:contour.bounds.top,width:contour.bounds.width,height:contour.bounds.height}}
          viewBox={`${contour.bounds.left} ${contour.bounds.top} ${contour.bounds.width} ${contour.bounds.height}`}>
          <g transform="translate(-750 -525) scale(1.5)">{contour.paths.map((path) => <path key={path.level} data-level={path.level} d={path.d} />)}</g>
        </svg></ViewportPortal>}
        {wideArea && activity && workingNode && <ConnectionWorker key={activity.id} activity={activity} position={workingNode.position} campRef={campRef} />}
        {wideArea && <MiniMap ariaLabel="繋がりMAPの俯瞰図" pannable zoomable nodeColor={(node) => node.className?.includes('connection-root') ? '#345e69' : node.className?.includes('connection-candidate') ? '#c78b52' : '#6e9aa0'} nodeStrokeColor="#365d63" nodeStrokeWidth={3} maskColor="#c9d9d955" />}
      </ReactFlow>
      <div className="connection-legend"><span>━━ 深掘りMAP</span><span>┄┄ 未探索</span></div>
    </div>
  );
}

export function MapManager({
  onOpenMap,
  onDeleted,
  initialMapId,
}: {
  onOpenMap: (mapId: string, conceptId?: string) => void;
  onDeleted: (mapId: string) => void;
  initialMapId?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState<MapList | null>(null);
  const [selected, setSelected] = useState<string | null>(initialMapId ?? null);
  const [detail, setDetail] = useState<MapDetail | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'states' | 'history'>('overview');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = () => api<MapList>('/maps').then(setData).catch((e) => setError(String(e)));
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    void api<MapDetail>(`/maps/${selected}`)
      .then((item) => {
        if (!active) return;
        setDetail(item);
        setTitle(item.title);
        setScope(item.scope ?? '');
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [selected]);
  const matchingMaps = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (data?.maps ?? []).filter((item) => !term || `${item.title} ${item.scope ?? ''}`.toLocaleLowerCase().includes(term));
  }, [data, query]);
  const filteredMaps = useMemo(() => {
    const result = matchingMaps.filter((item) => filter === 'all' || (filter === 'assessed' ? item.stats.diagnosed_concepts > 0 : item.stats.weak_concepts > 0));
    return result.sort((left, right) => {
      const order =
        sort === 'name'
          ? mapNameOrder.compare(left.title, right.title)
          : sort === 'diagnosed'
          ? right.stats.diagnosed_concepts - left.stats.diagnosed_concepts
          : sort === 'weak'
          ? right.stats.weak_concepts - left.stats.weak_concepts
          : Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return order || mapNameOrder.compare(left.title, right.title) || left.map_id.localeCompare(right.map_id);
    });
  }, [matchingMaps, filter, sort]);
  useEffect(() => {
    if (data && selected && !filteredMaps.some((item) => item.map_id === selected)) setSelected(null);
  }, [data, selected, filteredMaps]);
  const conditions: ListCondition[] = [];
  if (query.trim()) conditions.push({ key: 'query', label: `検索：${query.trim()}`, onRemove: () => setQuery('') });
  if (filter !== 'all') conditions.push({ key: 'filter', label: mapFilterOptions.find((item) => item.value === filter)!.label, onRemove: () => setFilter('all') });
  const clearConditions = () => {
    setQuery('');
    setFilter('all');
    setSort('recent');
  };
  async function save() {
    if (!selected || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await apiMethod(`/maps/${selected}`, 'PATCH', { title: title.trim(), scope: scope.trim() || null });
      setEditing(false);
      await refresh();
      setDetail(await api<MapDetail>(`/maps/${selected}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!selected || !detail || !window.confirm(`「${detail.title}」を削除しますか？このマップの回答履歴と分解結果も削除されます。元に戻せません。`)) return;
    setBusy(true);
    setError('');
    try {
      await apiMethod(`/maps/${selected}`, 'DELETE');
      onDeleted(selected);
      setSelected(null);
      setDetail(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="map-page">
      <div className="page-title">
        <div>
          <span className="eyebrow">DEEP DIVE MAPS</span>
          <h1>深堀マップ一覧</h1>
          <p>作成したマップを検索して、深掘りを続けられます。</p>
        </div>
      </div>
      <ListToolbar
        searchLabel="深掘りマップを検索"
        placeholder="マップ名・テーマの詳細情報"
        query={query}
        onQueryChange={setQuery}
        sort={sort}
        sortOptions={mapSortOptions}
        onSortChange={setSort}
        conditions={conditions}
        onReset={clearConditions}
        canReset={!!query || filter !== 'all' || sort !== 'recent'}
        resultCount={data ? filteredMaps.length : undefined}
        resultLabel="深掘りマップ"
        filters={
          <div className="list-filter-options" role="group" aria-label="マップの状態で絞り込み">
            {mapFilterOptions.map((option) => {
              const count = matchingMaps.filter((item) => option.value === 'all' || (option.value === 'assessed' ? item.stats.diagnosed_concepts > 0 : item.stats.weak_concepts > 0)).length;
              return (
                <button
                  type="button"
                  key={option.value}
                  aria-pressed={filter === option.value}
                  className={filter === option.value ? 'active' : ''}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                  <b>{count}</b>
                </button>
              );
            })}
          </div>
        }
      />
      {error && <p className="error-banner" role="alert">{error}</p>}
      {!data ? (
        <p className="muted">マップを読み込んでいます…</p>
      ) : data.maps.length === 0 ? (
        <p className="panel empty-map">まだ深掘りマップがありません。テーマを入力して最初の深掘りマップを作成してください。</p>
      ) : (
        <div className={`map-management ${detail ? '' : 'without-detail'}`}>
          <section className="panel map-list-area" aria-label="深掘りマップの一覧">
            {filteredMaps.length === 0 ? (
              <div className="list-no-results">
                <h2>条件に合うマップがありません</h2>
                <p>検索語や絞り込みを変更してください。</p>
                <button className="secondary" onClick={clearConditions}>条件をクリア</button>
              </div>
            ) : (
              filteredMaps.map((item) => (
                <article key={item.map_id} data-map-id={item.map_id} className={`map-list-card ${selected === item.map_id ? 'selected' : ''}`}>
                  <div className="map-card-heading">
                    <h3>{item.title}</h3>
                    <time dateTime={item.updated_at}>更新 {date(item.updated_at)}</time>
                  </div>
                  {item.scope && <p className="map-card-description">{item.scope}</p>}
                  <div className="map-card-footer">
                    <div className="map-card-counts">
                      <span>知識項目 <b>{item.stats.explored_concepts}</b></span>
                      <span>理解度確認 <b>{item.stats.diagnosed_concepts}</b></span>
                      {item.stats.weak_concepts > 0 && <span className="map-weak-count">理解度：低 <b>{item.stats.weak_concepts}</b></span>}
                    </div>
                    <div className="map-card-actions">
                      <button className="secondary" onClick={() => setSelected(item.map_id)} aria-pressed={selected === item.map_id}>詳細</button>
                      <button className="primary" onClick={() => onOpenMap(item.map_id)}>開く <ArrowRight size={14} /></button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
          {detail && (
            <aside className="panel map-detail">
              <h2>{detail.title}</h2>
              <p className="muted">{detail.origin ? `${detail.origin.source_map_title ?? '展開元'} › ${detail.origin.source_concept_name ?? detail.origin.source_concept_id} から展開` : 'テーマから作成したマップ'}</p>
              {detail.origin && (
                <>
                  <p><b>関係：</b>{detail.origin.relation}</p>
                  <p><b>理由：</b>{detail.origin.reason}</p>
                </>
              )}
              <Stats stats={detail.stats} />
              <div className="page-tabs">
                <button className={detailTab === 'overview' ? 'active' : ''} onClick={() => setDetailTab('overview')}>概要</button>
                <button className={detailTab === 'states' ? 'active' : ''} onClick={() => setDetailTab('states')}>理解状態</button>
                <button className={detailTab === 'history' ? 'active' : ''} onClick={() => setDetailTab('history')}>回答履歴</button>
              </div>
              {detailTab === 'overview' &&
                (editing ? (
                  <div className="map-edit">
                    <label>マップ名<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                    <label>範囲・レベル<textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={4} /></label>
                    <button className="primary" disabled={busy || !title.trim()} onClick={() => void save()}>保存</button>
                    <button className="secondary" onClick={() => setEditing(false)}>キャンセル</button>
                  </div>
                ) : (
                  <div className="map-detail-actions">
                    <p>{detail.scope || '範囲・レベルの指定なし'}</p>
                    <button className="primary" onClick={() => onOpenMap(detail.map_id)}>マップを開く</button>
                    <button className="secondary" onClick={() => setEditing(true)}>編集</button>
                    <button className="text-button delete-map-button" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />削除</button>
                  </div>
                ))}
              {detailTab === 'states' && (
                <div className="map-state-list">
                  {Object.entries(detail.session.understanding_summaries)
                    .filter(([id]) => id !== detail.session.knowledge_tree.concept_id)
                    .map(([id, state]) => (
                      <p key={id}>
                        <span>{findNode(detail.session.knowledge_tree, id)?.concept_name ?? id}</span>
                        <b>{understandingLabel[state.level]}</b>
                        <small>信頼度 {understandingLabel[state.confidence_level]}</small>
                      </p>
                    ))}
                </div>
              )}
              {detailTab === 'history' && <History items={detail.history} maps={data.maps} currentMapId={detail.map_id} />}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function findNode(node: KnowledgeNode, id: string): KnowledgeNode | undefined {
  if (node.concept_id === id) return node;
  for (const child of node.child_nodes) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

export function UnderstandingPage({
  onOpenMap,
  widening,
  onWiden,
  atlas = false,
  entry,
}: {
  onOpenMap: (mapId: string, conceptId?: string) => void;
  widening?: WideningState | null;
  onWiden?: (mapId: string, conceptId: string, conceptName: string) => void;
  atlas?: boolean;
  entry: {mode:'list'|'map';revision:number};
}) {
  const [data, setData] = useState<MapList | null>(null);
  const [lineageId, setLineageId] = useState('');
  const [lineageQuery, setLineageQuery] = useState('');
  const [lineageSort, setLineageSort] = useState('recent');
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [concepts, setConcepts] = useState<ConceptSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [detailOpen, setDetailOpen] = useState(!atlas);
  const [detailView, setDetailView] = useState<'selected' | 'candidates'>('selected');
  const [connectionJob, setConnectionJob] = useState<ConnectionActivity | null>(null);

  useEffect(() => {
    if (entry.mode === 'list') { setLineageId(''); setSelectedMapId(null); }
  }, [entry.revision, entry.mode]);

  useEffect(() => {
    if (!atlas || !widening) return;
    setDetailView('candidates');
    if (widening.status !== 'generating') setDetailOpen(true);
  }, [atlas, widening?.requestId, widening?.status]);

  useEffect(() => {
    let active = true;
    setError('');
    if (widening?.result) setSelectedMapId(widening.result.candidates[0]?.id ?? widening.mapId);
    void api<MapList>('/maps')
      .then((result) => {
        if (!active) return;
        setData(result);
        const source = result.maps.find((item) => item.map_id === widening?.mapId);
        if (entry.mode === 'map' && source) {
          const candidateId = widening?.result?.candidates[0]?.id;
          const candidate = result.candidates?.find((item) => item.id === candidateId);
          setLineageId(source.lineage_id);
          setSelectedMapId(candidate?.target_map_id ?? candidateId ?? source.map_id);
        } else if (entry.mode === 'list') {
          setLineageId('');
          setSelectedMapId(null);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'マップを読み込めませんでした。');
      });
    return () => {
      active = false;
    };
  }, [widening?.requestId, widening?.status, reload]);

  const displayData = useMemo(() => {
    if (!data || !widening?.result) return data;
    const known = new Set((data.candidates ?? []).map((item) => item.id));
    return {
      ...data,
      candidates: [
        ...(data.candidates ?? []),
        ...widening.result.candidates
          .filter((item) => !known.has(item.id))
          .map((item) => ({
            ...item,
            source_map_id: widening.mapId,
            source_concept_id: widening.conceptId,
            source_concept_name: widening.conceptName,
            target_map_id: null,
          })),
      ],
    };
  }, [data, widening]);

  const highlightedIds = useMemo(() => widening?.result?.candidates.map((item) => item.id) ?? [], [widening?.result]);
  const selectedMap = displayData?.maps.find((item) => item.map_id === selectedMapId) ?? null;
  const selectedCandidate = displayData?.candidates?.find((item) => item.id === selectedMapId && !item.target_map_id) ?? null;
  const wideningBusy = widening?.status === 'generating';
  const activity = connectionJob ?? (wideningBusy && widening ? { id: widening.requestId, targetId: widening.mapId, kind: 'survey' as const } : null);

  useEffect(() => {
    if (!selectedMap) {
      setConcepts(null);
      return;
    }
    let active = true;
    setConcepts(null);
    void api<{ concepts: ConceptSummary[] }>(`/understanding-summary/${selectedMap.lineage_id}/maps/${selectedMap.map_id}`)
      .then((result) => {
        if (active) setConcepts(result.concepts);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [selectedMap?.map_id, selectedMap?.lineage_id]);

  function chooseLineage(nextId: string) {
    setLineageId(nextId);
    const lineage = data?.lineages.find((item) => item.lineage_id === nextId);
    setSelectedMapId(nextId ? lineage?.root_map_id ?? data?.maps.find((item) => item.lineage_id === nextId)?.map_id ?? null : null);
    if (atlas) { setDetailOpen(false); setDetailView('selected'); }
  }

  function selectConnection(id: string) {
    setSelectedMapId(id);
    if (atlas) { setDetailOpen(true); setDetailView('selected'); }
  }

  const visibleMaps = displayData?.maps.filter((item) => !lineageId || item.lineage_id === lineageId) ?? [];
  const visibleCandidates = displayData?.candidates?.filter((item) => !item.target_map_id && visibleMaps.some((map) => map.map_id === item.source_map_id)) ?? [];
  const selectedLineage = data?.lineages.find((item) => item.lineage_id === lineageId);
  const rootMapTitle = data?.maps.find((item) => item.map_id === selectedLineage?.root_map_id)?.title ?? selectedLineage?.title;
  const pageHeading = rootMapTitle && lineageId ? connectionTitle(rootMapTitle) : '繋がりMAP一覧';
  const lineageCards = (data?.lineages ?? []).filter((lineage) => {
    const term = lineageQuery.trim().toLocaleLowerCase();
    return !term || [lineage.title, ...data!.maps.filter((map) => map.lineage_id === lineage.lineage_id).map((map) => map.title)]
      .some((title) => title.toLocaleLowerCase().includes(term));
  }).sort((left, right) => {
    if (lineageSort === 'name') return mapNameOrder.compare(left.title, right.title);
    if (lineageSort === 'maps') return right.map_ids.length - left.map_ids.length || mapNameOrder.compare(left.title, right.title);
    const updated = (lineage: Lineage) => Math.max(0, ...data!.maps.filter((map) => map.lineage_id === lineage.lineage_id).map((map) => Date.parse(map.updated_at) || 0));
    return updated(right) - updated(left) || mapNameOrder.compare(left.title, right.title);
  });
  const wideningNotice = widening && <section className="connection-generation" aria-label="知識を広げる">
    <div>
      <strong>{widening.conceptName}</strong>
      <p role={widening.status === 'failed' ? 'alert' : 'status'}>
        {widening.status === 'generating' ? <><LoaderCircle className="spin" size={15} />候補を探しています…</>
          : widening.status === 'failed' ? widening.error : `新しい候補 ${highlightedIds.length}件`}
      </p>
    </div>
    {onWiden && <button className="secondary" disabled={widening.status === 'generating'} onClick={() => onWiden(widening.mapId, widening.conceptId, widening.conceptName)}>
      {widening.status === 'failed' ? '候補の生成を再試行' : '別の候補を探す'}
    </button>}
  </section>;

  async function exploreCandidate() {
    if (!selectedCandidate || busy) return;
    setBusy(true);
    setError('');
    if (atlas) setDetailOpen(false);
    setConnectionJob({ id: `create-${Date.now()}`, targetId: selectedCandidate.id, kind: 'build' });
    try {
      const created = await api<{ session: Diagnosis }>(
        `/maps/${selectedCandidate.source_map_id}/concepts/${selectedCandidate.source_concept_id}/divergence/${selectedCandidate.id}/create`,
        {}
      );
      onOpenMap(created.session.session_id);
    } catch (e) {
      setError(String(e));
    } finally {
      setConnectionJob(null);
      setBusy(false);
    }
  }

  async function widenSelectedMap() {
    if (!selectedMap || !onWiden || busy || wideningBusy) return;
    setBusy(true);
    setError('');
    try {
      const detail = await api<MapDetail>(`/maps/${selectedMap.map_id}`);
      onWiden(selectedMap.map_id, detail.session.knowledge_tree.concept_id, detail.session.knowledge_tree.concept_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'このMAPから候補を探せませんでした。');
    } finally {
      setBusy(false);
    }
  }

  async function widenCandidate() {
    if (!selectedCandidate || !onWiden || busy || wideningBusy) return;
    setBusy(true);
    setError('');
    if (atlas) setDetailOpen(false);
    setConnectionJob({ id: `create-${Date.now()}`, targetId: selectedCandidate.id, kind: 'build' });
    try {
      const created = await api<{ session: Diagnosis }>(
        `/maps/${selectedCandidate.source_map_id}/concepts/${selectedCandidate.source_concept_id}/divergence/${selectedCandidate.id}/create`,
        {}
      );
      onWiden(created.session.session_id, created.session.knowledge_tree.concept_id, created.session.knowledge_tree.concept_name);
    } catch (e) {
      setError(e instanceof Error ? e.message : '候補からMAPを作成できませんでした。');
    } finally {
      setConnectionJob(null);
      setBusy(false);
    }
  }

  return (
    <div className="map-page connection-page">
      <div className="page-title">
        <div>
          <h1 title={rootMapTitle ?? ''}><Compass size={21} aria-hidden="true" />{pageHeading}</h1>
        </div>
      </div>
      {!atlas && wideningNotice}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button className="text-button" onClick={() => setReload((value) => value + 1)}>マップを再読み込み</button>
        </div>
      )}
      {!data ? (
        <p className="muted">マップを読み込んでいます…</p>
      ) : data.maps.length === 0 ? (
        <p className="panel empty-map">まだ深掘りマップがありません。深掘り画面でテーマを入力して最初の深掘りマップを作成してください。</p>
      ) : !lineageId ? (
        <>
          <ListToolbar searchLabel="繋がりMAPの系統を検索" placeholder="系統名・マップ名" query={lineageQuery} onQueryChange={setLineageQuery}
            sort={lineageSort} sortOptions={[{value:'recent',label:'最近更新した順'},{value:'name',label:'系統名順'},{value:'maps',label:'マップ数が多い順'}]}
            onSortChange={setLineageSort} conditions={lineageQuery ? [{key:'query',label:`検索：${lineageQuery}`,onRemove:()=>setLineageQuery('')}] : []}
            onReset={()=>{setLineageQuery('');setLineageSort('recent');}} canReset={!!lineageQuery || lineageSort !== 'recent'}
            resultCount={lineageCards.length} resultLabel="系統" />
          <section className="panel connection-lineage-list" aria-label="繋がりMAPの系統一覧">
            {lineageCards.length ? lineageCards.map((lineage) => {
              const maps = data.maps.filter((map) => map.lineage_id === lineage.lineage_id);
              const root = maps.find((map) => map.map_id === lineage.root_map_id);
              const candidates = (data.candidates ?? []).filter((candidate) => !candidate.target_map_id && maps.some((map) => map.map_id === candidate.source_map_id));
              const updated = maps.reduce((latest,map) => Date.parse(map.updated_at)>Date.parse(latest) ? map.updated_at : latest, maps[0]?.updated_at ?? '');
              return <article className="map-list-card connection-lineage-card" data-lineage-id={lineage.lineage_id} key={lineage.lineage_id}>
                <div className="connection-lineage-title"><span className="connection-lineage-icon"><ConnectionGlyph kind="root" /></span>
                  <div className="map-card-heading"><h3>{root?.title ?? lineage.title}</h3><time dateTime={updated}>更新 {date(updated)}</time></div></div>
                <div className="map-card-footer"><div className="map-card-counts"><span>深掘りMAP <b>{maps.length}</b></span><span>未探索の候補 <b>{candidates.length}</b></span></div>
                  <div className="map-card-actions"><button className="primary" onClick={()=>chooseLineage(lineage.lineage_id)}>地図を開く <ArrowRight size={14}/></button></div></div>
              </article>;
            }) : <div className="list-no-results"><h2>該当する系統がありません</h2><button className="secondary" onClick={()=>setLineageQuery('')}>検索をクリア</button></div>}
          </section>
        </>
      ) : (
        <>
          <div className="connection-toolbar">
            <button className="secondary connection-back" onClick={() => chooseLineage('')}><ArrowLeft size={14}/>系統一覧へ</button>
            <span>
              {visibleMaps.length} MAP · 候補 {visibleCandidates.length}件
            </span>
          </div>
          <div className="connection-layout">
            <MapConnections
              data={displayData ?? data}
              lineageId={lineageId}
              selectedMapId={selectedMapId}
              onSelect={selectConnection}
              highlightedIds={highlightedIds}
              wideArea={atlas}
              activity={activity}
            />
            {atlas && !detailOpen && <button className="connection-detail-tab" aria-label="繋がりMAPの調査手帳を開く" aria-expanded="false" aria-controls="connection-detail" onClick={() => setDetailOpen(true)}>
              <span className="connection-detail-tab-icon"><ConnectionGlyph kind={selectedCandidate ? 'candidate' : 'map'} /></span>
              <span><b>{detailView === 'candidates' ? '未探索の候補' : selectedCandidate ? '未探索の候補' : 'MAPの記録'}</b><small>{detailView === 'candidates' ? wideningBusy ? '候補を探索中…' : `${visibleCandidates.length}件の候補` : selectedCandidate?.name ?? selectedMap?.title ?? '選択中のMAP'}</small></span>
            </button>}
            {(!atlas || detailOpen) && <aside id="connection-detail" className="panel connection-detail" aria-label={atlas ? '繋がりMAPの調査手帳' : '選択した深掘りマップの詳細'}>
              {atlas && <div className="connection-detail-heading">
                <button className={detailView === 'selected' ? 'active' : ''} aria-pressed={detailView === 'selected'} onClick={() => setDetailView('selected')}>選択中</button>
                <button className={detailView === 'candidates' ? 'active' : ''} aria-pressed={detailView === 'candidates'} onClick={() => setDetailView('candidates')}>未探索の候補 <small>{visibleCandidates.length}</small></button>
                <button className="connection-detail-close" aria-label="調査手帳を閉じる" onClick={() => setDetailOpen(false)}><X size={16} /></button>
              </div>}
              {atlas && detailView === 'candidates' && <div className="connection-candidates-page">
                {widening && (!lineageId || visibleMaps.some((map) => map.map_id === widening.mapId)) && wideningNotice}
                {visibleCandidates.length ? <div className="connection-candidate-list">
                  {visibleCandidates.map((candidate) => <button key={candidate.id} className={candidate.id === selectedMapId ? 'active' : ''} onClick={() => selectConnection(candidate.id)}>
                    <ConnectionGlyph kind="candidate" />
                    <span><b>{candidate.name}</b><small>{candidate.category} · {candidate.source_concept_name}</small></span>
                    {highlightedIds.includes(candidate.id) && <em>NEW</em>}
                  </button>)}
                </div> : <p className="muted">未探索の候補はまだありません。</p>}
              </div>}
              {(!atlas || detailView === 'selected') && selectedCandidate && (
                <>
                  <span className="eyebrow connection-detail-kicker"><MapPin size={14} aria-hidden="true" />未探索の候補</span>
                  <h2>{selectedCandidate.name}</h2>
                  <span className="candidate-category">{selectedCandidate.category}</span>
                  <div className="connection-origin">
                    <b>展開元</b>
                    <p>
                      {data.maps.find((item) => item.map_id === selectedCandidate.source_map_id)?.title} › {selectedCandidate.source_concept_name}
                    </p>
                    <b>関係</b>
                    <p>{selectedCandidate.relation}</p>
                    <b>理由</b>
                    <p>{selectedCandidate.reason}</p>
                  </div>
                  <button className="primary" disabled={busy} onClick={() => void exploreCandidate()}>
                    {busy ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}このテーマで深掘りを始める
                  </button>
                  {onWiden && <button className="secondary connection-expand" disabled={busy || wideningBusy} onClick={() => void widenCandidate()}>
                    {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}さらに広げる
                  </button>}
                </>
              )}
              {(!atlas || detailView === 'selected') && selectedMap && (
                <>
                  <span className="eyebrow connection-detail-kicker"><Compass size={14} aria-hidden="true" />深掘りMAP</span>
                  <h2>{selectedMap.title}</h2>
                  {selectedMap.origin ? (
                    <div className="connection-origin">
                      <b>展開元</b>
                      <p>
                        {selectedMap.origin.source_map_title ?? '削除済みのMAP'} › {selectedMap.origin.source_concept_name ?? selectedMap.origin.source_concept_id}
                      </p>
                      <b>関係</b>
                      <p>{selectedMap.origin.relation}</p>
                      <b>理由</b>
                      <p>{selectedMap.origin.reason}</p>
                    </div>
                  ) : (
                    <p className="muted">この系統の起点となるMAPです。</p>
                  )}
                  <Stats stats={selectedMap.stats} />
                  <button className="primary" onClick={() => onOpenMap(selectedMap.map_id)}>
                    この深掘りマップを開く <ArrowRight size={15} />
                  </button>
                  {onWiden && <button className="secondary connection-expand" disabled={busy || wideningBusy} onClick={() => void widenSelectedMap()}>
                    {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}このMAPから繋がりを探す
                  </button>}
                  <div className="connection-concepts">
                    <h3>項目から広げる</h3>
                    {!concepts ? (
                      <p className="muted">読み込んでいます…</p>
                    ) : (
                      <div className="concept-summary-list">
                        {concepts.map((item) => (
                          <div className="connection-concept-row" key={item.concept_id}>
                            <button onClick={() => onOpenMap(selectedMap.map_id, item.concept_id)}>
                              <span>{item.concept_name}{item.other_map_ids.length > 0 && <small>別のMAPでも確認</small>}</span>
                              <b>{understandingLabel[item.level]}</b>
                              <ArrowRight size={14} />
                            </button>
                            {onWiden && <button className="connection-concept-expand" title={`${item.concept_name}から繋がりを探す`} aria-label={`${item.concept_name}から繋がりを探す`} disabled={wideningBusy} onClick={() => onWiden(selectedMap.map_id, item.concept_id, item.concept_name)}><GitBranch size={14} /></button>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </aside>}
          </div>
        </>
      )}
    </div>
  );
}

export function DivergenceDrawer({
  mapId,
  node,
  onClose,
  onCreated,
}: {
  mapId: string;
  node: KnowledgeNode;
  onClose: () => void;
  onCreated: (session: Diagnosis) => void;
}) {
  const [result, setResult] = useState<DivergenceResult | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agentProgress, setAgentProgress] = useState<AgentProgress | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setAgentProgress({ agent: 'divergence', stage: 'generating_candidates', message: `「${node.concept_name}」からの関連トピックを探索中...` });
    void apiStream<DivergenceResult>(`/maps/${mapId}/concepts/${node.concept_id}/divergence`, {}, (prog) => {
      if (active) setAgentProgress(prog);
    })
      .then((data) => {
        if (active) {
          setResult(data);
          setAgentProgress({ agent: 'divergence', stage: 'completed', message: '関連トピック探索完了' });
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [mapId, node.concept_id]);

  async function create() {
    if (!selected) return;
    setBusy(true);
    setError('');
    setAgentProgress({ agent: 'decomposition', stage: 'creating_map', message: `「${selected.name}」の知識マップを生成中...` });
    try {
      const created = await apiStream<{ session: Diagnosis }>(`/maps/${mapId}/concepts/${node.concept_id}/divergence/${selected.id}/create`, {}, (prog) => {
        setAgentProgress(prog);
      });
      setAgentProgress({ agent: 'decomposition', stage: 'completed', message: '知識マップ生成完了' });
      onCreated(created.session);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="divergence-drawer" role="dialog" aria-modal="true" aria-label={`${node.concept_name}から知識を広げる`} onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">DIVERGENCE</span>
            <h2>「{node.concept_name}」から知識を広げる</h2>
          </div>
          <button className="text-button" aria-label="閉じる" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <AgentStatusBadge progress={agentProgress} />
        {error && <p className="error-banner" role="alert">{error}</p>}
        {busy && !result && (
          <p className="drawer-loading">
            <LoaderCircle className="spin" size={18} />展開先を探しています…
          </p>
        )}
        {selected ? (
          <div className="candidate-detail">
            <button className="text-button" onClick={() => setSelected(null)}>
              <ArrowLeft size={15} />候補一覧に戻る
            </button>
            <h3>{selected.name}</h3>
            <span className="candidate-category">{selected.category}</span>
            <h4>元の知識との関係</h4>
            <div className="relation-path">
              <span>{node.concept_name}</span>
              <ArrowRight size={17} />
              <span>{selected.relation}</span>
              <ArrowRight size={17} />
              <strong>{selected.name}</strong>
            </div>
            <h4>なぜ関係する？</h4>
            <p>{selected.reason}</p>
            <button className="primary wide" disabled={busy} onClick={() => void create()}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <GitBranch size={16} />}このテーマで知識マップを作成
            </button>
          </div>
        ) : (
          result && (
            <>
              <p>{result.candidates.length}件の候補</p>
              <div className="candidate-scroll">
                {result.candidates.map((candidate) => (
                  <article key={candidate.id} className="candidate-card">
                    <h3>{candidate.name}</h3>
                    <span className="candidate-category">{candidate.category}</span>
                    <p>{candidate.relation}</p>
                    <button className="secondary" onClick={() => setSelected(candidate)}>
                      詳細 <ArrowRight size={14} />
                    </button>
                  </article>
                ))}
              </div>
            </>
          )
        )}
      </aside>
    </div>
  );
}
