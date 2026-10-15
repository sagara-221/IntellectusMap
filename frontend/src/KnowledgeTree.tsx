// ==============================================================================
// 知識グラフ・ツリー可視化コンポーネント (KnowledgeTree)
// 用途: React Flow および d3-force 力学モデルによる概念ノードの配置・描画・インタラクション
// ==============================================================================
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, useNodesState, type NodeProps, type Node, type Edge, type ReactFlowInstance } from '@xyflow/react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import '@xyflow/react/dist/style.css';
import { Search, Focus } from 'lucide-react';
import { type DecompositionStatus, type Diagnosis, type KnowledgeNode, type LearningState, type UnderstandingSummary, flatten, understandingLabel, visibleConceptIds } from './types';
import { type AgentProgress, AGENT_CONFIGS, DEFAULT_AGENT_CONFIG } from './api';

// グラフ描画用カスタムノード（ConceptDot）に渡すデータ型
type CardData = {
  concept: KnowledgeNode;
  state: LearningState;
  summary: UnderstandingSummary | undefined;
  decompositionStatus: DecompositionStatus | undefined;
  active: boolean;
  selected: boolean;
  dim: boolean;
  labelLane: 0 | 1;
  hasChildren: boolean;
  terminalVisible: boolean;
  onSelect: (id: string) => void;
  agentProgress?: AgentProgress | null;
  isAssessing?: boolean;
};
type GraphNode = Node<CardData>;
type Point = {x: number; y: number};
type ForceDatum = SimulationNodeDatum & {id: string; depth: number; branchAngle: number};
type ForceEdge = SimulationLinkDatum<ForceDatum>;


function ConceptDot({ data }: NodeProps<GraphNode>) {
  const {concept, state, summary, decompositionStatus, active, selected, dim, labelLane, hasChildren, terminalVisible, onSelect, agentProgress, isAssessing} = data;
  const covered = concept.assessment_scope === 'covered_by_parent';
  const terminal = concept.depth > 0 && terminalVisible && concept.child_candidates.length === 0 && !hasChildren;
  const expansionFailed = !!concept.expansion_error && !hasChildren;
  const isUnanswered = concept.depth > 0 && (!state || (state.questions_answered ?? 0) === 0);
  const isGenerating = decompositionStatus === 'generating';
  const isAgentActive = !!agentProgress || isGenerating;
  const agentInfo = agentProgress
    ? (AGENT_CONFIGS[agentProgress.agent] || DEFAULT_AGENT_CONFIG)
    : isGenerating
    ? AGENT_CONFIGS.DecompositionAgent
    : null;
  const agentMessage = agentProgress?.message || (isGenerating ? '下位概念ノードを並列生成中...' : '');

  const hasAssessedLevel = !isAssessing && ((summary?.level && summary.level !== 'unknown') || !isUnanswered);
  const currentLevelClass = isAssessing ? 'assessing' : (summary?.level ?? 'unknown');

  const nodeStyle = isAgentActive && agentInfo ? {
    '--agent-color': agentInfo.color,
    '--agent-glow': agentInfo.glow,
    '--agent-pulse': agentInfo.pulseColor,
  } as CSSProperties : undefined;

  return <div
    className={`graph-dot label-lane-${labelLane} ${currentLevelClass} ${covered ? 'covered' : ''} ${active ? 'current' : ''} ${selected ? 'selected' : ''} ${dim ? 'dim' : ''} ${terminal ? 'terminal' : ''} ${expansionFailed ? 'expansion-failed' : ''} ${isGenerating ? 'generating' : ''} ${isUnanswered && !isAssessing ? 'unanswered' : ''} ${concept.depth === 0 ? 'root' : ''} ${isAgentActive ? 'agent-working' : ''}`}
    style={nodeStyle}
  >
    <Handle type="target" position={Position.Top}/>
    {isAgentActive && agentInfo && (
      <div className="graph-agent-floating-bubble" style={{ borderColor: agentInfo.color, boxShadow: `0 8px 24px rgba(0, 0, 0, 0.5), 0 0 20px ${agentInfo.glow}` }}>
        <span className="agent-bubble-pulse" style={{ backgroundColor: agentInfo.color }} />
        <span className="agent-bubble-icon">{agentInfo.icon}</span>
        <div className="agent-bubble-content">
          <span className="agent-bubble-name" style={{ color: agentInfo.color }}>{agentInfo.agentName} 動作中</span>
          <span className="agent-bubble-action">{agentMessage || agentInfo.label}</span>
        </div>
      </div>
    )}
    <button className="graph-node-button nodrag" onClick={() => onSelect(concept.concept_id)} aria-label={`${concept.concept_name}の診断詳細`} aria-pressed={selected} title={`${concept.concept_name}\n${concept.description}\n${agentProgress ? `【実行中】${agentInfo?.agentName ?? agentProgress.agent} - ${agentProgress.message}` : isGenerating ? '下位項目を並列生成中' : expansionFailed ? `分解失敗：${concept.expansion_error}` : terminal ? `AIの末端判定：${concept.terminal_reason ?? 'これ以上の分解候補なし'}` : `推定理解度：${understandingLabel[summary?.level ?? 'unknown']}`}`}>
      <span className="graph-core" style={isAgentActive && agentInfo && !hasAssessedLevel ? { backgroundColor: agentInfo.color } : undefined}/>
      {isAgentActive && (
        <span className="graph-agent-ring" style={{ borderColor: agentInfo?.color }} />
      )}
      <span className="graph-label">
        <strong style={isAgentActive && agentInfo ? { color: agentInfo.color, textShadow: `0 0 10px ${agentInfo.glow}` } : undefined}>{concept.concept_name}</strong>
        {isAgentActive && agentInfo ? (
          <span className="graph-agent-badge" style={{ background: agentInfo.color, boxShadow: `0 2px 8px ${agentInfo.pulseColor}` }}>
            <span className="agent-badge-icon">{agentInfo.icon}</span>
            <span>{agentInfo.agentName} 稼働中</span>
          </span>
        ) : (
          <small>{concept.depth === 0 ? `全体：${understandingLabel[summary?.level ?? 'unknown']}` : isAssessing ? '解答を採点・診断中…' : isGenerating ? '下位項目を生成中…' : expansionFailed ? '分解を再試行できます' : terminal ? 'AI判定 · 分解候補なし' : `理解度：${understandingLabel[summary?.level ?? 'unknown']}`}</small>
        )}
      </span>
    </button>
    <span className="drag-ring" title="ドラッグで配置を移動"/>
    <Handle type="source" position={Position.Bottom}/>
  </div>;
}

const nodeTypes = {concept: ConceptDot};

export default function KnowledgeTree({session, selected, onSelect, activeAgentProgress, assessingConceptId}: {session: Diagnosis; selected: string | null; onSelect: (id: string) => void; activeAgentProgress?: AgentProgress | null; assessingConceptId?: string | null}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [instance, setInstance] = useState<ReactFlowInstance<GraphNode> | null>(null);
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [neighborsOnly, setNeighborsOnly] = useState(false);
  const [settling, setSettling] = useState(false);
  const positions = useRef(new Map<string, Point>());
  const simulation = useRef<Simulation<ForceDatum, ForceEdge> | null>(null);
  const flowInstance = useRef<ReactFlowInstance<GraphNode> | null>(null);
  const animationFrame = useRef<number | null>(null);
  const layoutWidth = useRef(window.innerWidth);
  const visible = visibleConceptIds(session);
  const concepts = flatten(session.knowledge_tree).filter(node => visible.has(node.concept_id));
  const conceptById = useMemo(() => new Map(concepts.map(concept => [concept.concept_id, concept])), [concepts]);
  const links = useMemo(() => {
    const result: Edge[] = [];
    concepts.forEach(node => node.child_nodes.filter(child => visible.has(child.concept_id)).forEach(child => result.push({id:`part:${node.concept_id}:${child.concept_id}`,source:node.concept_id,target:child.concept_id,type:'straight',data:{kind:'part'}})));
    (session.concept_edges ?? []).filter(edge => edge.relation === 'part' && visible.has(edge.source) && visible.has(edge.target)).forEach(edge =>
      result.push({id:`part:${edge.source}:${edge.target}`,source:edge.source,target:edge.target,type:'straight',data:{kind:'part'}}));
    return result;
  }, [session.knowledge_tree, session.concept_edges]);
  const topology = concepts.map(node => node.concept_id).join('|') + '/' + links.map(edge => edge.id).join('|');

  function startSimulation(reset = false) {
    simulation.current?.stop();
    if (animationFrame.current != null) cancelAnimationFrame(animationFrame.current);
    if (reset) positions.current.clear();
    const spacing = Math.max(1, Math.min(2.2, window.innerWidth / 1500));
    const horizontalStretch = window.innerWidth >= 2200 ? Math.min(3, window.innerWidth / 1200) : 1;

    const rootChildren = session.knowledge_tree.child_nodes.filter(child => visible.has(child.concept_id));
    const branchAngles = new Map(rootChildren.map((child, index) => [child.concept_id, -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, rootChildren.length)]));
    const topBranch = (concept: KnowledgeNode) => {
      let branch = concept;
      while (branch.depth > 1 && branch.parent_concept_id) {
        const parent = conceptById.get(branch.parent_concept_id);
        if (!parent) break;
        branch = parent;
      }
      return branch.depth === 1 ? branch.concept_id : null;
    };
    const data: ForceDatum[] = concepts.map((concept, index) => {
      const branchAngle = branchAngles.get(topBranch(concept) ?? '') ?? 0;
      const old = positions.current.get(concept.concept_id);
      const parent = concept.parent_concept_id ? positions.current.get(concept.parent_concept_id) : undefined;
      const jitter = ((index * 1.61803398875) % 1 - .5) * .7;
      const radius = Math.max(80, concept.depth * 155) * spacing;
      return {
        id:concept.concept_id,
        depth:concept.depth,
        branchAngle,
        x:old?.x ?? parent?.x ?? Math.cos(branchAngle + jitter) * radius * horizontalStretch,
        y:old?.y ?? parent?.y ?? Math.sin(branchAngle + jitter) * radius,
        fx:concept.depth === 0 ? 0 : undefined,
        fy:concept.depth === 0 ? 0 : undefined,
      };
    });
    const forceEdges: ForceEdge[] = links.map(link => ({source:link.source,target:link.target}));
    const commit = () => {
      animationFrame.current = null;
      const next = new Map(data.map(node => [node.id, {x:node.x ?? 0,y:node.y ?? 0}]));
      positions.current = next;
      setNodes(previous => data.map(datum => {
        const concept = conceptById.get(datum.id)!;
        const old = previous.find(node => node.id === datum.id);
        return {...old,id:datum.id,type:'concept',position:next.get(datum.id)!,data:old?.data ?? {concept,state:session.learning_states[datum.id],summary:session.understanding_summaries?.[datum.id],decompositionStatus:session.decomposition_statuses?.[datum.id],active:false,selected:false,dim:false,labelLane:0,hasChildren:false,terminalVisible:session.manual_flow !== 'decomposition_first' || concept.terminal_confirmed,onSelect}};
      }));
    };
    const scheduleCommit = () => {
      if (animationFrame.current == null) animationFrame.current = requestAnimationFrame(commit);
    };

    setSettling(true);
    const nextSimulation = forceSimulation<ForceDatum>(data)
      .alpha(1)
      .alphaMin(.025)
      .alphaDecay(.045)
      .velocityDecay(.32)
      .force('link', forceLink<ForceDatum, ForceEdge>(forceEdges).id(node => node.id).distance(150 * spacing).strength(.58))
      .force('charge', forceManyBody<ForceDatum>().strength(node => (node.depth === 0 ? -950 : -500) * spacing * spacing).distanceMax(900 * spacing))
      .force('collision', forceCollide<ForceDatum>().radius(node => (node.depth <= 1 ? 105 : 86) * spacing).strength(1).iterations(2))
      .force('branch-x', forceX<ForceDatum>(node => node.depth === 0 ? 0 : Math.cos(node.branchAngle) * node.depth * 155 * spacing * horizontalStretch).strength(node => node.depth === 0 ? 1 : .055 * horizontalStretch))
      .force('branch-y', forceY<ForceDatum>(node => node.depth === 0 ? 0 : Math.sin(node.branchAngle) * node.depth * 155 * spacing).strength(node => node.depth === 0 ? 1 : .055))
      .on('tick', scheduleCommit)
      .on('end', () => {
        if (animationFrame.current != null) cancelAnimationFrame(animationFrame.current);
        commit();
        setSettling(false);
        requestAnimationFrame(() => void flowInstance.current?.fitView({padding:.35,maxZoom:1.2,duration:250}));
      });
    simulation.current = nextSimulation;
  }

  useEffect(() => {
    startSimulation();
    return () => {
      simulation.current?.stop();
      if (animationFrame.current != null) cancelAnimationFrame(animationFrame.current);
    };
    // The topology deliberately restarts physics only when nodes are added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology]);

  useEffect(() => {
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (Math.abs(window.innerWidth - layoutWidth.current) > 80) {
          layoutWidth.current = window.innerWidth;
          startSimulation(true);
        } else {
          void flowInstance.current?.fitView({padding:.3,duration:0});
        }
      }, 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
    // Rebuild the force layout only when the graph changes or the viewport moves
    // to a materially different width; minor resizes simply refit the nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology]);

  const neighborhood = useMemo(() => new Set([selected,...links.filter(edge => edge.source===selected || edge.target===selected).flatMap(edge => [edge.source,edge.target])]), [links, selected]);
  const query = search.trim().toLocaleLowerCase();
  const matches = concepts.filter(node => node.concept_name.toLocaleLowerCase().includes(query) || node.description.toLocaleLowerCase().includes(query));
  const matchIds = new Set(matches.map(node => node.concept_id));
  const visibleNodes: GraphNode[] = nodes.map(node => {
    const concept=conceptById.get(node.id)!;
    const active=session.next_question?.concept_id===node.id;
    const isSelected=selected===node.id;
    const parent=concept.parent_concept_id ? conceptById.get(concept.parent_concept_id) : undefined;
    const siblingIndex=parent?.child_nodes.findIndex(child=>child.concept_id===concept.concept_id)??0;
    let isAgentTarget = false;
    if (activeAgentProgress) {
      const isQuestionOrEvaluation = activeAgentProgress.agent === 'QuestionAgent' || activeAgentProgress.agent === 'EvaluationAgent';

      if (concept.depth === 0 && isQuestionOrEvaluation) {
        // 出題・採点は個別学習項目のみが対象。中心ノード（テーマ、depth===0）は絶対に対象外
        isAgentTarget = false;
      } else if (activeAgentProgress.concept_id) {
        isAgentTarget = activeAgentProgress.concept_id === node.id;
      } else if (activeAgentProgress.concept_name) {
        isAgentTarget = activeAgentProgress.concept_name === concept.concept_name && !(concept.depth === 0 && isQuestionOrEvaluation);
      } else {
        if (isQuestionOrEvaluation) {
          isAgentTarget = concept.depth > 0 && active;
        } else if (activeAgentProgress.agent === 'DecompositionAgent') {
          // 選択中ノードを勝手に分解ターゲットにせず、実際に生成中ステータスのノード、またはルートを対象にする
          isAgentTarget = session.decomposition_statuses?.[node.id] === 'generating' || concept.depth === 0;
        } else {
          isAgentTarget = concept.depth === 0;
        }
      }
    }
    const nodeAgentProgress = isAgentTarget ? activeAgentProgress : null;
    const isAssessing = assessingConceptId === node.id;
    return {...node,data:{...node.data,concept,state:session.learning_states[node.id],summary:session.understanding_summaries?.[node.id],decompositionStatus:session.decomposition_statuses?.[node.id],active,selected:isSelected,dim:(!!query&&!matchIds.has(node.id)) || (neighborsOnly&&!neighborhood.has(node.id)),labelLane:(siblingIndex%2) as 0|1,hasChildren:links.some(edge=>edge.source===node.id),terminalVisible:session.manual_flow !== 'decomposition_first' || concept.terminal_confirmed,onSelect,agentProgress:nodeAgentProgress,isAssessing}};
  });
  const edges: Edge[] = links.map(edge => ({...edge,style:{...edge.style,stroke:selected===edge.source||selected===edge.target?'#b2d4cb':'#465852',strokeWidth:selected===edge.source||selected===edge.target?1.8:1,opacity:neighborsOnly && !(edge.source===selected || edge.target===selected) ? .15 : .75}}));

  useEffect(() => {
    if (!instance || nodes.length !== concepts.length || nodes.some(node => !node.measured?.width)) return;
    void instance.fitView({padding:.4,maxZoom:1.2,duration:180});
  }, [instance, topology, nodes.length, nodes.every(node => !!node.measured?.width), concepts.length]);

  function focus(id: string) {
    onSelect(id);
    void instance?.fitView({nodes:[{id}],padding:1,maxZoom:1.2,duration:250});
  }

  function stopSimulationForDrag() {
    simulation.current?.stop();
    if (animationFrame.current != null) {
      cancelAnimationFrame(animationFrame.current);
      animationFrame.current = null;
    }
    setSettling(false);
  }

  return <div className="knowledge-graph" style={{'--graph-zoom':zoom} as CSSProperties}>
    <div className="graph-tools"><label className="graph-search"><Search size={15}/><input aria-label="知識項目を検索" placeholder="知識を検索…" value={search} onChange={event=>setSearch(event.target.value)}/></label><button className={neighborsOnly?'enabled':''} aria-pressed={neighborsOnly} onClick={()=>setNeighborsOnly(!neighborsOnly)}>関連のみ</button><button className={settling?'enabled':''} disabled={settling} onClick={()=>startSimulation(true)}>{settling?'配置中…':'配置を整える'}</button><button aria-label="グラフ全体を表示" onClick={()=>void instance?.fitView({padding:.4,duration:0})}><Focus size={16}/></button></div>
    {query && <div className="graph-search-results">{matches.length ? matches.slice(0,20).map(node=><button key={node.concept_id} onClick={()=>{focus(node.concept_id);setSearch('');}}>{node.concept_name}<small>第{node.depth+1}層</small></button>) : <p>該当する項目がありません。</p>}</div>}
    <ReactFlow<GraphNode> nodes={visibleNodes} edges={edges} onNodesChange={onNodesChange} onInit={flow => {setInstance(flow);flowInstance.current=flow;}} onMove={(_,viewport)=>setZoom(viewport.zoom)} onNodeDragStart={stopSimulationForDrag} onNodeDragStop={(_,node)=>positions.current.set(node.id,node.position)} onNodeClick={(_,node)=>onSelect(node.id)} nodeTypes={nodeTypes} fitView fitViewOptions={{padding:.3}} minZoom={.15} maxZoom={2} nodesDraggable nodesConnectable={false} deleteKeyCode={null} proOptions={{hideAttribution:false}}><Background color="#405149" gap={26} size={1}/><Controls showInteractive={false}/></ReactFlow>
    <div className="graph-link-legend"><span>― 構成する項目</span><span className="graph-layout-status">{settling?'配置を計算中…':`力学配置 · 全${concepts.length-1}項目を表示`}</span></div>
  </div>;
}
