// ==============================================================================
// フロントエンド型定義モジュール (Types)
// 用途: 診断セッション、知識ツリーノード、理解度状態、出題・回答エビデンス、コスト集計の型定義
// ==============================================================================

// 探索モード: manual (手動探索), focused (弱点集中), comprehensive (網羅的診断)
export type ExplorationMode = 'manual' | 'focused' | 'comprehensive';

// 出題問題の形式種別
export type QuestionType = 'multiple_choice' | 'yes_no' | 'short_answer' | 'short_explanation' | 'free_response';

// 回答形式の設定
export type AnswerFormat = 'auto' | 'choice' | 'written';
export const answerFormatLabels: Record<AnswerFormat,string> = {auto:'自動（内容に合わせる）',choice:'選択式のみ',written:'記述式中心'};

// ノードごとの理解度ステータス
export type Status = 'not_assessed' | 'assessing' | 'uncertain' | 'weak' | 'learning' | 'mastered';

// ノード分解（子ノード生成）のステータス: generating (生成中), ready (生成完了), failed (失敗), available (未着手)
export type DecompositionStatus = 'queued' | 'generating' | 'ready' | 'failed' | 'available';

// 到達目標・評価対象
export interface Target { target_id: string; description: string; importance: string }


// 知識ツリーのノード表現
export interface KnowledgeNode {
  concept_id: string;
  concept_name: string;
  description: string;
  granularity: 'broad' | 'medium' | 'narrow';
  depth: number;
  parent_concept_id: string | null;
  parent_ids: string[];
  aliases: string[];
  merged_from_ids: string[];
  source_target_ids: Record<string,string[]>;
  merged_sources: {concept:{concept_id:string; concept_name:string; description:string}; parent_concept_id:string|null; origin:string; user_note:string|null}[];
  prerequisite_concept_ids: string[];
  child_candidates: {concept_name:string; description?:string}[]; // 将来の深掘り候補（軽量化のため説明文は省略）
  terminal_reason: string | null;
  terminal_confirmed: boolean;
  expansion_error: string | null;
  status: Status;
  assessment_scope: 'direct' | 'covered_by_parent';
  expansion_kind: 'none' | 'diagnostic' | 'display_only';
  origin: 'generated' | 'user_added';
  user_note: string | null;
  assessment_targets: Target[];
  child_nodes: KnowledgeNode[];
}

export interface TargetState { understanding_score: number | null; diagnostic_confidence: number; questions_answered: number; status: Status }
export interface LearningState extends TargetState { target_states: Record<string, TargetState>; detected_misconceptions: {description: string; confidence: number}[] }
export type SurveyLevel = 'high' | 'medium' | 'low' | 'unsure';
export type UnderstandingLevel = 'high' | 'medium' | 'low' | 'unknown';
export interface UnderstandingSummary { level: UnderstandingLevel; score: number | null; confidence_level: UnderstandingLevel; confidence_score: number | null; source: 'descendants' | 'question' | 'self_report' | 'needs_question' | 'not_answered' | 'conversation' | 'mixed'; assessed: number; total: number; missing: number; question_answers: number; survey_answers: number; conversation_answers?: number }
export const understandingLabel: Record<UnderstandingLevel,string> = {high:'高',medium:'中',low:'低',unknown:'未判定'};
export interface UnderstandingSummary { evidence_sources?: ('question'|'conversation'|'self_report')[]; provisional?: boolean }
export const certaintyLabel = (value: number | null | undefined) => value == null || value === 0 ? '未判定' : value >= .7 ? '高' : value >= .4 ? '中' : '低';

// 出題される質問データ
export interface Question { question_id: string; concept_id: string; assessment_target_id: string; question_type: QuestionType; question_text: string; choices: { choice_id: string; text: string }[] | null; expected_answer?: string[]; answer_explanation?: string }

// ユーザー回答の採点結果・エビデンス
export interface Evidence { evidence_id: string; question_id: string; concept_id: string; correctness: string; score: number; evaluation_confidence: number; user_answer: string; demonstrated_knowledge: string[]; missing_knowledge: string[]; grading_method: string; origin_map_id?: string | null; answered_at?: string | null }

// レビューサマリー
export interface FindingsReview { review_id: string; concept_id: string; concept_name: string; layer: number; summary: string; demonstrated: string[]; weak_candidates: string[]; unresolved: string[]; evidence_ids: string[]; diagnostic_confidence: number; unassessed_concepts: number; can_expand: boolean; next_step: string }

// 診断セッション全体のデータ構造
export interface Diagnosis {
  session_id: string;
  revision: number;
  theme: string;
  mode: 'demo' | 'gemini';
  exploration_mode: ExplorationMode;
  manual_flow: 'combined' | 'decomposition_first';
  decomposition_max_depth: number | null;
  initial_visible_depth: number;
  initial_generation_complete: boolean;
  initial_root_pending?: boolean;
  decomposition_depth_reason: string | null;
  focused_path: string[];
  answer_format: AnswerFormat;
  allowed_question_types: QuestionType[] | null;
  reassessment_concept_id: string | null;
  active_concept_id: string | null;
  paused_concept_ids: string[];
  awaiting_selection: boolean;
  knowledge_tree: KnowledgeNode;
  concept_edges: {source:string; target:string; relation:string}[];
  concept_redirects: Record<string,string>;
  learning_states: Record<string, LearningState>;
  next_question: Question | null;
  pending_review: FindingsReview | null;
  next_action: {reason_code: string; action: string} | null;
  evaluation: Evidence | null;
  evidence: Evidence[];
  question_history: Question[];
  questions_answered: number;
  max_total_questions: number | null;
  complete: boolean;
  stop_reason: string | null;
  error: string | null;
  metrics: {display_only_concepts: number; unassessed_concepts: number; written_answers: number; ungradable_answers: number; answer_time_ms: number; assessed_concepts: number; weak_concepts: number};
}
export interface Diagnosis { domain_context: string | null }
export interface Diagnosis { decomposition_statuses: Record<string, DecompositionStatus> }
export interface Diagnosis { agent_capacities?: Partial<Record<AgentRole, number>>; cross_map_active_count?: number }
export type AgentRole = 'miner'|'question'|'evaluation'|'merge'|'reception'|'recorder';
export interface AgentHandoff {event_id:string;from_role:AgentRole;to_role:AgentRole;from_job_id:string|null;to_job_id:string|null;concept_id:string|null;source:string;kind:'request'|'result';created_at:number}
export interface AgentJob {job_id:string;session_id:string;role:AgentRole;concept_id:string|null;source:string;status:'queued'|'running'|'complete'|'failed'|'cancelled';error:string|null;retryable:boolean;updated_at:number}
export interface Diagnosis {
  agent_runtime?: {scope:'session';revision:number;counts:Record<AgentRole,{capacity:number;running:number;queued:number;idle:number}>;jobs:AgentJob[];handoffs?:AgentHandoff[]};
  question_statuses?: Record<string,{status:'available'|'queued'|'generating'|'ready'|'failed'|'cancelled';unanswered_count:number;answered_count:number;error:string|null;retryable:boolean;job_id:string|null}>;
  deleted_concept_ids?:string[];
}
export interface Diagnosis { self_assessments: Record<string,{level:SurveyLevel;answered_at:string}>; understanding_summaries: Record<string,UnderstandingSummary> }

// チャット・会話診断
export interface ChatMessage {message_id:string;role:'user'|'assistant';content:string;status:'pending'|'complete'|'failed';created_at:string;conversation_id?:string}
export interface ChatConversation {conversation_id:string;title:string;created_at:string}
export interface ChatObservation {observation_id:string;turn_id:string;concept_id:string;target_id:string;score:number;confidence:number;kind:'demonstrated'|'gap'|'self_report';citations:{message_id:string;quote:string}[];demonstrated:string[];missing:string[];reason:string;created_at:string}
export interface ChatJob {turn_id:string;status:"queued"|"running"|"complete"|"failed";phase:"extracting"|"planning"|"updating"|"assessing"|"complete";total_chunks:number;completed_chunks:number[];updated_concept_ids:string[];deferred_reasons:string[];error:string|null}
export interface ChatState {evidence_queue?:{unit_id:string;status:'pending'|'waiting'|'insufficient'|'resolved'|'ignored';reason:string}[];reconciliation_phase?:'idle'|'waiting'|'matching'|'assessing'|'adding';jobs?:ChatJob[];opened_concept_ids?:string[];messages:ChatMessage[];observations:ChatObservation[];focus_concept_id:string|null;conversation_guidance:string;foreground_turn_id:string|null;background_turn_id:string|null;background_status:'idle'|'queued'|'running'|'failed';background_error:string|null;created_concept_ids:string[];timings:Record<string,number>;current_conversation_id?:string;conversations?:ChatConversation[]}
export interface Diagnosis {chat?:ChatState;conversation_assessed_concept_ids?:string[]}
export const hasAssessment = (session:Diagnosis, id:string) => !!session.self_assessments?.[id] || !!session.conversation_assessed_concept_ids?.includes(id);

// APIコスト集計
export interface AgentCost {
  agent_name: string;
  calls: number;
  prompt_tokens: number;
  candidates_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  estimated_cost_jpy?: number;
}
export interface SessionCost {
  total_calls: number;
  prompt_tokens: number;
  candidates_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  estimated_cost_jpy: number;
  by_agent: Record<string, AgentCost>;
}
export interface Diagnosis { canonical_refs?: Record<string,{canonical_id:string;other_maps:string[];other_map_titles:string[]}>; cross_map_matching?: boolean; cost_summary?: SessionCost }
export const statusLabel: Record<Status, string> = { not_assessed: '未確認', assessing: '診断中', uncertain: '要確認', weak: '弱点候補', learning: '理解の途中', mastered: '理解を確認' };
export const percent = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value * 100)}%`;
export function flatten(node: KnowledgeNode): KnowledgeNode[] { return [node, ...node.child_nodes.flatMap(flatten)]; }
export interface SessionSummary { session_id: string; theme: string; complete: boolean; questions_answered: number; created_at?: string; updated_at?: string; }

export function visibleConceptIds(session: Diagnosis): Set<string> {
  return new Set(flatten(session.knowledge_tree).map(node => node.concept_id));
}
