"""理解の地図（Knowledge Gap Mapper）のドメインモデル定義。

知識マップのノード構造（Node, ConceptSpec, Target）、学習診断の状態管理
（LearningState, TargetState, Misconception）、出題・回答・採点（Question, Evaluation, Evidence）、
概念マージ（MergeProposal, CanonicalConcept）、セッションおよびコスト管理モデルを集約。
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.models.chat import ChatState


def uid(prefix: str) -> str:
    """プレフィックス付きの一意なIDを生成"""
    return f'{prefix}_{uuid4().hex[:16]}'


class Model(BaseModel):
    """プロジェクト全体の基底 Pydantic モデル（余分なフィールド禁止、文字列前後の空白自動トリム）"""
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


KnowledgeType = Literal['factual', 'conceptual', 'calculation', 'procedural', 'application']
Status = Literal['not_assessed', 'assessing', 'uncertain', 'weak', 'learning', 'mastered']
ExplorationMode = Literal['manual', 'focused', 'comprehensive']
AnswerFormat = Literal['auto', 'choice', 'written']
QuestionType = Literal['multiple_choice', 'yes_no', 'short_answer', 'short_explanation', 'free_response']


class Target(Model):
    """評価目標: 概念内で具体的に「何を理解・計算・判断できるか」を表す最小評価単位"""
    target_id: str = Field(min_length=1)
    description: str = Field(min_length=1)
    knowledge_type: KnowledgeType
    importance: Literal['core', 'supporting'] = 'core'
    prerequisite_target_ids: list[str] = Field(default_factory=list)


class Candidate(Model):
    """将来の深掘り候補（概念名のみ保持、トークン節約のため詳細説明は廃止）"""
    model_config = ConfigDict(extra='ignore', str_strip_whitespace=True)
    concept_name: str


class ConceptSpec(Model):
    """LLMが生成・入出力する知識概念の仕様モデル"""
    concept_id: str = Field(min_length=1)
    concept_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    granularity: Literal['broad', 'medium', 'narrow']
    knowledge_type: KnowledgeType
    assessment_targets: list[Target] = Field(min_length=1, max_length=5)
    child_candidates: list[Candidate] = Field(default_factory=list, max_length=5,
        description='この項目をさらに掘り下げる際の具体的な候補。出題できる項目でも候補があれば記載する')
    terminal_reason: str | None = Field(default=None, max_length=500,
        description='複数の観点から検討しても有効な下位能力が存在しない場合の具体的な理由')
    prerequisite_concept_ids: list[str] = Field(default_factory=list)

    @model_validator(mode='after')
    def unique_targets(self):
        ids = [t.target_id for t in self.assessment_targets]
        if len(ids) != len(set(ids)):
            raise ValueError('Target IDs must be unique within a concept')
        if any(p not in ids or p == t.target_id for t in self.assessment_targets for p in t.prerequisite_target_ids):
            raise ValueError('Invalid prerequisite target reference')
        return self


class MergedConceptSource(Model):
    """概念マージ時に統合元となった元の概念情報"""
    concept: ConceptSpec
    parent_concept_id: str | None
    origin: Literal['generated', 'user_added'] = 'generated'
    user_note: str | None = None


class Node(ConceptSpec):
    """ツリー構造を構成する生きた知識マップノード（階層深さ、子ノード群、学習ステータスを保持）"""
    parent_concept_id: str | None = None
    depth: int = Field(default=0, ge=0)
    child_nodes: list[Node] = Field(default_factory=list)
    terminal_confirmed: bool = False
    assessment_scope: Literal['direct', 'covered_by_parent'] = 'direct'
    expansion_kind: Literal['none', 'diagnostic', 'display_only'] = 'none'
    expansion_error: str | None = Field(default=None, max_length=1000)
    status: Status = 'not_assessed'
    origin: Literal['generated', 'user_added'] = 'generated'
    user_note: str | None = None
    parent_ids: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    merged_from_ids: list[str] = Field(default_factory=list)
    source_target_ids: dict[str, list[str]] = Field(default_factory=dict)
    merged_sources: list[MergedConceptSource] = Field(default_factory=list)
    creation_source: Literal['decomposition', 'chat'] | None = None


class KnowledgeEdge(Model):
    """ノード間の関係エッジ（親子・上位概念・下位概念・重複等）"""
    source: str
    target: str
    relation: Literal['part', 'broader', 'narrower', 'overlap'] = 'part'


class ConceptRelationJudgeResult(Model):
    """LLMによる2つの概念間の関係判定結果（同一・包含・重複・相違）"""
    relation: Literal['same', 'broader', 'narrower', 'overlap', 'different']
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1)
    evidence_shareable: bool


class ConceptPair(Model):
    """概念マージ判定用の入力ペア"""
    existing: ConceptSpec
    incoming: ConceptSpec
    existing_parent: str | None
    incoming_parent: str | None
    theme: str


class CanonicalTarget(Model):
    """統合後の標準評価目標"""
    description: str = Field(min_length=1)
    knowledge_type: KnowledgeType
    importance: Literal['core', 'supporting'] = 'core'
    source_target_ids: list[str] = Field(min_length=1)


class CanonicalConcept(Model):
    """統合後の標準概念モデル（別名リストや統合後の評価目標一覧を含む）"""
    name: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    description: str = Field(min_length=1)
    targets: list[CanonicalTarget] = Field(min_length=1, max_length=5)


class MergeProposal(Model):
    """概念の統合提案（既存概念と新規概念のマージプラン）"""
    incoming_id: str
    existing_id: str
    existing_text_hash: str
    canonical: CanonicalConcept
    similarity: float


class AddConceptRequest(Model):
    """ユーザーによるノード手動追加リクエスト"""
    parent_concept_id: str = Field(min_length=1)
    concept_name: str = Field(min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)


class AdditionInput(Model):
    """LLMへの概念追加プロンプト入力モデル"""
    concept_id: str
    concept_name: str
    note: str | None = None
    parent_concept: ConceptSpec
    siblings: list[ConceptSpec]
    domain_context: str | None = None
    target_depth: int
    existing_concept_ids: list[str]


class CoverageFacet(Model):
    """観点計画における個別の切り口・観点（名称と診断フォーカス）"""
    name: str = Field(min_length=1)
    diagnostic_focus: str = Field(min_length=1)


class FacetPlan(Model):
    """知識分解の事前観点計画（戦略、観点一覧、推奨表示深さ、終了理由）"""
    strategy: Literal['breadth', 'concretize', 'terminal']
    facets: list[CoverageFacet] = Field(max_length=12)
    suggested_initial_depth: int | None = Field(default=None, ge=1, le=2,
        description='互換用の項目。初回の表示層はバックエンドで2に固定し、深掘りではnullに補正する')
    terminal_reason: str | None = Field(default=None, min_length=1)

    @model_validator(mode='after')
    def consistent_facets(self):
        if (self.strategy == 'terminal') != (not self.facets):
            raise ValueError('A terminal plan has no facets; an active plan has facets')
        if (self.strategy == 'terminal') != bool(self.terminal_reason and self.terminal_reason.strip()):
            raise ValueError('Only a terminal plan has a concrete terminal reason')
        names = [facet.name for facet in self.facets]
        if len(names) != len(set(names)):
            raise ValueError('Planned facet names must be unique')
        return self


class DecompositionInput(Model):
    """知識分解エージェント（DecompositionAgent）への入力パラメータ群"""
    theme: str = Field(description='初回は全体テーマ、深掘りでは選択した項目名')
    parent_concept_id: str | None = Field(default=None, description='深掘り対象のconcept_id。初回はnull')
    current_depth: int = Field(default=0, description='深掘り対象の層。ルートは0')
    purpose: Literal['initial_decomposition', 'expand_weak_concept', 'expand_concept', 'display_mastered_concept'] = Field(default='initial_decomposition', description='分解の用途')
    domain_context: str | None = Field(default=None, description='利用者が入力したテーマの詳細情報')
    root_theme: str | None = Field(default=None, description='初回に設定した全体テーマ')
    target_concept: ConceptSpec | None = Field(default=None, description='深掘りする項目の説明・評価目標・既存の分解候補')
    ancestor_path: list[str] = Field(default_factory=list, description='全体テーマから対象の親までの項目名を順に並べたもの')
    sibling_concept_names: list[str] = Field(default_factory=list, description='対象と同じ親を持つ既存項目名')
    max_children: int = 5
    weak_targets: list[str] = Field(default_factory=list)
    mistake_details: list[str] = Field(default_factory=list, description='学習者が具体的に間違えた問題、誤答内容、誤解の記録')
    existing_concept_ids: list[str] = Field(default_factory=list)
    is_divergent_map: bool = False
    force_concretize: bool = Field(default=False, description='停止候補を具体的な適用場面から再検討する場合だけtrue')
    minimum_facets: int = Field(default=1, ge=1, le=10)
    coverage_plan: FacetPlan | None = Field(default=None, description='先に決めた観点の計画。子項目生成または計画の再検討で使用')
    generation_feedback: Literal['empty_children', 'missing_facet_coverage'] | None = Field(
        default=None, description='前回の子項目生成を修正するときの不整合')
    reconsider_plan: bool = Field(default=False, description='子項目生成に失敗したため観点計画を再検討する場合だけtrue')


class Decomposition(Model):
    """知識分解の出力モデル（親概念、分解された子ノード群、概要）"""
    root_concept: ConceptSpec
    child_nodes: list[ConceptSpec] = Field(max_length=10, description='直下の診断可能な能力。候補がない場合は空配列')
    decomposition_summary: str
    suggested_initial_depth: int | None = Field(default=None, ge=1, le=2,
        description='互換用の項目。初回はバックエンドで2に固定し、初回以外はnullに補正する')

    @model_validator(mode='after')
    def unique_nodes(self):
        ids = [self.root_concept.concept_id] + [n.concept_id for n in self.child_nodes]
        if len(ids) != len(set(ids)):
            raise ValueError('Duplicate concept IDs')
        for node in self.child_nodes:
            if node.granularity in ('broad', 'medium') and not node.child_candidates:
                raise ValueError('Broad and medium child concepts require decomposition candidates')
            if node.granularity == 'narrow' and not node.child_candidates and not node.terminal_reason:
                raise ValueError('Terminal narrow concepts require a terminal reason')
            if node.child_candidates and node.terminal_reason:
                raise ValueError('Expandable concepts cannot have a terminal reason')
        return self


class FacetCoverage(Model):
    """計画された各観点（facet）がどの子概念（child_concept_ids）でカバーされたかの対応関係"""
    facet_name: str = Field(min_length=1)
    child_concept_ids: list[str] = Field(min_length=1)


class AuditedDecomposition(Model):
    """観点カバレッジ監査付きの分解結果モデル（LLM検証用）"""
    decomposition: Decomposition
    coverage: list[FacetCoverage] = Field(max_length=12)

    @model_validator(mode='after')
    def complete_coverage(self):
        children = {node.concept_id for node in self.decomposition.child_nodes}
        if not children:
            if self.coverage:
                raise ValueError('Terminal decomposition must have no coverage entries')
            return self
        linked_names = [link.facet_name for link in self.coverage]
        if len(linked_names) != len(set(linked_names)):
            raise ValueError('Coverage entries must refer to distinct facets')
        referenced = [identifier for link in self.coverage for identifier in link.child_concept_ids]
        if set(referenced) != children or any(identifier not in children for identifier in referenced):
            raise ValueError('Every child must cover a facet and every facet must cite generated children')
        return self


class PreparedDecomposition(Model):
    """分解結果とマージ提案、類似度比較ハッシュをまとめた事前準備データ"""
    decomposition: Decomposition
    proposals: list[MergeProposal] = Field(default_factory=list)
    compared_concept_ids: list[str] = Field(default_factory=list)
    compared_concept_hashes: dict[str, str] = Field(default_factory=dict)


class TargetState(Model):
    """単一の評価目標（到達目標）に対する理解度・正誤判定状態"""
    target_id: str
    understanding_score: float | None = None
    diagnostic_confidence: float = 0
    questions_answered: int = 0
    correct_count: int = 0
    status: Status = 'not_assessed'
    evidence_ids: list[str] = Field(default_factory=list)


class Misconception(Model):
    """検出された誤解・つまずきの記録"""
    description: str
    confidence: float = Field(ge=0, le=1)


class LearningState(Model):
    """概念ノード単位での学習診断状態（理解度スコア、確信度、出題履歴、検出された誤解群）"""
    concept_id: str
    understanding_score: float | None = None
    diagnostic_confidence: float = 0
    status: Status = 'not_assessed'
    questions_answered: int = 0
    correct_count: int = 0
    target_states: dict[str, TargetState] = Field(default_factory=dict)
    detected_misconceptions: list[Misconception] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)


class SelfAssessment(Model):
    """ユーザーによる自己評価記録（高い・普通・低い・不明）"""
    level: Literal['high', 'medium', 'low', 'unsure']
    answered_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    origin_map_id: str | None = None


class SelfAssessmentRequest(Model):
    """自己評価送信リクエスト"""
    concept_id: str
    level: Literal['high', 'medium', 'low', 'unsure']


class QuestionRequest(Model):
    """出題エージェントへの単一出題要求（評価目標ID、形式、難易度、目的）"""
    assessment_target_id: str
    question_type: QuestionType
    difficulty: Literal['basic', 'medium', 'advanced'] = 'basic'
    question_count: Literal[1] = 1
    purpose: Literal['screening', 'mastery_check', 'misconception_check'] = 'screening'


class Plan(Model):
    """診断ポリシー（DiagnosticPolicy）が決定した次のアクション計画"""
    session_question_count: int = 0
    action: Literal['assess', 'continue_assessment', 'expand_concept', 'move_to_next_concept', 'review_findings', 'complete']
    concept_id: str | None = None
    question_requests: list[QuestionRequest] = Field(default_factory=list)
    expand_target_id: str | None = None
    reason_code: str


class Choice(Model):
    """多肢選択問題の選択肢（IDとテキスト）"""
    choice_id: str
    text: str


class DiagnosticMapping(Model):
    """誤答とつまずき（誤解）の対応関係定義"""
    answer: str
    misconception: str


class QuestionContent(Model):
    """LLMが生成した問題本文・正解・採点形式等のコンテンツモデル"""
    question_type: QuestionType
    question_text: str = Field(min_length=1, max_length=5000)
    choices: list[Choice] | None = None
    expected_answer: list[str] = Field(min_length=1)
    answer_explanation: str
    grading_type: Literal['choice_match', 'exact_match', 'symbolic_match', 'rule_based', 'semantic_evaluation']
    diagnostic_mapping: list[DiagnosticMapping] = Field(default_factory=list)

    @model_validator(mode='after')
    def consistent_grading(self):
        if self.question_type in ('multiple_choice', 'yes_no'):
            if not self.choices or len(self.choices) < 2:
                raise ValueError('Choice questions require options')
            ids = [c.choice_id for c in self.choices]
            if len(set(ids)) != len(ids) or len(self.expected_answer) != 1 or self.expected_answer[0] not in ids:
                raise ValueError('Choice question must have one valid answer ID')
            if self.grading_type not in ('choice_match', 'exact_match'):
                raise ValueError('Choice questions require deterministic grading')
            if self.question_type == 'yes_no' and set(ids) != {'yes', 'no'}:
                raise ValueError('Yes/no option IDs must be yes and no')
        elif self.grading_type == 'choice_match':
            raise ValueError('choice_match requires choices')
        return self


class Question(QuestionContent):
    """永続化・セッション管理用の個別問題オブジェクト（question_id、概念ID、目標IDを付与）"""
    question_id: str = Field(default_factory=lambda: uid('q'))
    concept_id: str
    assessment_target_id: str
    difficulty: str = 'basic'
    origin_map_id: str | None = None


class QuestionBatchContent(Model):
    """複数問題の一括生成コンテンツモデル"""
    questions: list[QuestionContent] = Field(min_length=1, max_length=5)


class QuestionInput(Model):
    """出題エージェント（QuestionAgent）への入力パラメータ群"""
    concept: ConceptSpec
    request: QuestionRequest
    domain_context: str | None = None
    previous_question_summaries: list[str] = Field(default_factory=list)
    ancestor_mistakes: list[str] = Field(default_factory=list, description='親や先祖ノード、過去の全層で学習者が具体的に間違えた内容や誤解')
    batch_count: int = 2


class Evaluation(Model):
    """LLMまたはルールエンジンによる回答採点結果（正誤、スコア、確信度、実証/不足知識）"""
    correctness: Literal['correct', 'partially_correct', 'incorrect', 'ungradable']
    score: float = Field(ge=0, le=1)
    evaluation_confidence: float = Field(ge=0, le=1)
    demonstrated_knowledge: list[str] = Field(default_factory=list)
    missing_knowledge: list[str] = Field(default_factory=list)
    misconception_candidates: list[Misconception] = Field(default_factory=list)
    needs_additional_assessment: bool = False

    @model_validator(mode='after')
    def consistent_score(self):
        if self.correctness == 'correct' and self.score != 1:
            raise ValueError('correct requires score=1')
        if self.correctness == 'incorrect' and self.score != 0:
            raise ValueError('incorrect requires score=0')
        if self.correctness == 'partially_correct' and not 0 < self.score < 1:
            raise ValueError('partial credit must be between 0 and 1')
        if self.correctness == 'ungradable' and (self.score != 0 or self.evaluation_confidence != 0):
            raise ValueError('ungradable requires score=0 and confidence=0')
        return self


class Evidence(Evaluation):
    """採点結果にユーザー回答や回答時間、変化した理解度スコアを記録した永続証拠モデル"""
    evidence_id: str = Field(default_factory=lambda: uid('ev'))
    question_id: str
    concept_id: str
    answered_at: str | None = None
    understanding_before: float | None = None
    understanding_after: float | None = None
    origin_map_id: str | None = None
    assessment_target_id: str
    user_answer: str
    user_confidence: Literal['high', 'medium', 'low'] | None = None
    answer_time_ms: int | None = None
    grading_method: str


class EvaluationInput(Model):
    """回答評価エージェント（EvaluationAgent）への入力パラメータ群"""
    question: Question
    user_answer: str
    user_confidence: Literal['high', 'medium', 'low'] | None = None
    answer_time_ms: int | None = None
    previous_evidence: list[Evidence] = Field(default_factory=list)


class PolicyConfig(Model):
    """診断ポリシーの閾値・上限パラメータ設定"""
    max_questions_per_concept: int = Field(default=7, ge=1, le=7)
    max_total_questions: int | None = Field(default=None, ge=1)
    max_depth: int | None = Field(default=None, ge=1)
    review_min_depth: int = Field(default=2, ge=0)
    mastery_threshold: float = .8
    weak_threshold: float = .4
    confidence_threshold: float = .7


class FindingsReview(Model):
    """診断途中で提示される中間振り返り・発見事項レビューモデル"""
    review_id: str = Field(default_factory=lambda: uid('review'))
    concept_id: str
    concept_name: str
    layer: int
    reason_code: str
    summary: str
    demonstrated: list[str]
    weak_candidates: list[str]
    unresolved: list[str]
    evidence_ids: list[str]
    diagnostic_confidence: float
    unassessed_concepts: int
    can_expand: bool
    next_step: str


class ReviewRequest(Model):
    """中間レビューに対するユーザーの選択リクエスト（ギャップ理解で終了するか、深掘り継続か）"""
    review_id: str
    decision: Literal['understood_gap', 'continue_exploring']


class ReviewDecision(Model):
    """中間レビューの判断履歴モデル"""
    review: FindingsReview
    decision: Literal['understood_gap', 'continue_exploring']
    questions_answered: int


class Reassessment(Model):
    """弱点克服や再判定のための再出題情報"""
    concept_id: str
    question: Question | None = None


class AgentExecution(Model):
    """エージェント（LLM呼び出し）単発実行のメトリクス記録（トークン数、レイテンシ、概算コスト）"""
    agent_name: str
    concept_id: str | None = None
    prompt_tokens: int = 0
    candidates_tokens: int = 0
    total_tokens: int = 0
    latency_ms: int = 0
    estimated_cost_usd: float = 0.0
    estimated_cost_jpy: float = 0.0
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class AgentCost(Model):
    """エージェント別の累計コスト・トークン統計"""
    agent_name: str
    calls: int = 0
    prompt_tokens: int = 0
    candidates_tokens: int = 0
    total_tokens: int = 0
    total_latency_ms: int = 0
    avg_latency_ms: float = 0.0
    estimated_cost_usd: float = 0.0
    estimated_cost_jpy: float = 0.0


class SessionCost(Model):
    """セッション全体およびエージェント別のコスト・トークン集計モデル"""
    total_calls: int = 0
    prompt_tokens: int = 0
    candidates_tokens: int = 0
    total_tokens: int = 0
    total_latency_ms: int = 0
    avg_latency_ms: float = 0.0
    estimated_cost_usd: float = 0.0
    estimated_cost_jpy: float = 0.0
    by_agent: dict[str, AgentCost] = Field(default_factory=dict)
    executions: list[AgentExecution] = Field(default_factory=list)

    def add(self, agent_name: str, prompt: int, candidates: int, latency_ms: int = 0, concept_id: str | None = None):
        self.total_calls += 1
        self.prompt_tokens += prompt
        self.candidates_tokens += candidates
        self.total_tokens += (prompt + candidates)
        self.total_latency_ms += latency_ms
        self.avg_latency_ms = round(self.total_latency_ms / self.total_calls, 1) if self.total_calls > 0 else 0.0

        # Gemini 3.5 Flash-Lite standard/global estimate (USD per 1M tokens).
        call_cost = (prompt / 1_000_000) * 0.30 + (candidates / 1_000_000) * 2.50
        call_cost_jpy = round(call_cost * 155, 4)
        self.estimated_cost_usd = round(self.estimated_cost_usd + call_cost, 6)
        self.estimated_cost_jpy = round(self.estimated_cost_usd * 155, 4)

        agent = self.by_agent.setdefault(agent_name, AgentCost(agent_name=agent_name))
        agent.calls += 1
        agent.prompt_tokens += prompt
        agent.candidates_tokens += candidates
        agent.total_tokens += (prompt + candidates)
        agent.total_latency_ms += latency_ms
        agent.avg_latency_ms = round(agent.total_latency_ms / agent.calls, 1) if agent.calls > 0 else 0.0
        agent.estimated_cost_usd = round(agent.estimated_cost_usd + call_cost, 6)
        agent.estimated_cost_jpy = round(agent.estimated_cost_usd * 155, 4)

        self.executions.append(AgentExecution(
            agent_name=agent_name,
            concept_id=concept_id,
            prompt_tokens=prompt,
            candidates_tokens=candidates,
            total_tokens=prompt + candidates,
            latency_ms=latency_ms,
            estimated_cost_usd=round(call_cost, 6),
            estimated_cost_jpy=call_cost_jpy,
        ))
        if len(self.executions) > 200:
            self.executions = self.executions[-200:]

    def merge(self, other: 'SessionCost | None') -> None:
        if not other:
            return
        all_agents = set(self.by_agent.keys()) | set(other.by_agent.keys())
        merged: dict[str, AgentCost] = {}
        total_p = 0
        total_c = 0
        total_calls = 0
        total_lat = 0
        for name in all_agents:
            a1 = self.by_agent.get(name)
            a2 = other.by_agent.get(name)
            if a1 and a2:
                best = a1 if a1.calls >= a2.calls else a2
            else:
                best = a1 or a2
            merged[name] = best.model_copy()
            total_p += best.prompt_tokens
            total_c += best.candidates_tokens
            total_calls += best.calls
            total_lat += best.total_latency_ms

        self.by_agent = merged
        self.prompt_tokens = total_p
        self.candidates_tokens = total_c
        self.total_tokens = total_p + total_c
        self.total_calls = total_calls
        self.total_latency_ms = total_lat
        self.avg_latency_ms = round(total_lat / total_calls, 1) if total_calls > 0 else 0.0
        self.estimated_cost_usd = round((total_p / 1_000_000) * 1.50 + (total_c / 1_000_000) * 7.50, 6)
        self.estimated_cost_jpy = round(self.estimated_cost_usd * 155, 4)

        existing_keys = {(e.agent_name, e.timestamp, e.total_tokens) for e in self.executions}
        for e in other.executions:
            key = (e.agent_name, e.timestamp, e.total_tokens)
            if key not in existing_keys:
                self.executions.append(e)
                existing_keys.add(key)
        self.executions.sort(key=lambda x: x.timestamp)
        if len(self.executions) > 200:
            self.executions = self.executions[-200:]


class Session(Model):
    """学習診断セッション全体の状態を管理する中心ドメインモデル。
    
    ツリー構造（knowledge_tree）、診断進行キュー（queue）、出題・回答証拠（evidence）、
    各概念の習熟度状態（learning_states）、APIコスト実績（cost_summary）などを集約保持。
    """
    session_id: str = Field(default_factory=lambda: uid('sess'))
    user_id: str = 'guest_user'
    theme: str
    domain_context: str | None = None
    mode: Literal['gemini', 'demo'] = 'gemini'
    exploration_mode: ExplorationMode = 'focused'
    manual_flow: Literal['combined', 'decomposition_first'] = 'combined'
    decomposition_max_depth: int | None = Field(default=None, ge=2, le=5)
    initial_visible_depth: int = Field(default=1, ge=1, le=3)
    initial_generation_complete: bool = True
    initial_root_pending: bool = False
    decomposition_depth_reason: str | None = None
    answer_format: AnswerFormat = 'auto'
    allowed_question_types: list[QuestionType] | None = Field(default=None, min_length=1, max_length=5)
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    
    # 知識マップのツリー構造本体
    knowledge_tree: Node
    concept_edges: list[KnowledgeEdge] = Field(default_factory=list)
    concept_redirects: dict[str, str] = Field(default_factory=dict)
    deleted_concept_ids: list[str] = Field(default_factory=list)
    merge_history: list[dict] = Field(default_factory=list)
    
    # 学習診断状態と履歴
    learning_states: dict[str, LearningState] = Field(default_factory=dict)
    self_assessments: dict[str, SelfAssessment] = Field(default_factory=dict)
    chat: ChatState = Field(default_factory=ChatState)
    questions: list[Question] = Field(default_factory=list)
    question_pool: dict[str, list[Question]] = Field(default_factory=dict)
    evidence: list[Evidence] = Field(default_factory=list)
    reassessment_question_ids: list[str] = Field(default_factory=list)
    reassessment: Reassessment | None = None
    active_concept_id: str | None = None
    paused_questions: dict[str, Question] = Field(default_factory=dict)
    pending_question: Question | None = None
    pending_review: FindingsReview | None = None
    review_history: list[ReviewDecision] = Field(default_factory=list)
    approved_expansion_id: str | None = None
    queue: list[str] = Field(default_factory=list)
    deferred_concepts: list[str] = Field(default_factory=list)
    focused_path: list[str] = Field(default_factory=list)
    completed_concepts: list[str] = Field(default_factory=list)
    next_action: Plan | None = None
    policy_history: list[Plan] = Field(default_factory=list)
    config: PolicyConfig = Field(default_factory=PolicyConfig)
    cost_summary: SessionCost = Field(default_factory=SessionCost)
    complete: bool = False
    stop_reason: str | None = None
    revision: int = 0
    first_weak_question: int | None = None
    first_weak_answer_time_ms: int | None = None


class StartRequest(Model):
    """診断セッション開始リクエスト（テーマ、コンテキスト、モード、回答形式等）"""
    theme: str = Field(min_length=1, max_length=300)
    entry_mode: Literal['map', 'chat', 'map_chat'] = 'map'
    domain_context: str | None = Field(default=None, max_length=12000)
    mode: Literal['demo', 'gemini'] | None = 'gemini'
    exploration_mode: ExplorationMode = 'manual'
    manual_flow: Literal['combined', 'decomposition_first'] = 'decomposition_first'
    answer_format: AnswerFormat = 'auto'
    allowed_question_types: list[QuestionType] | None = Field(default=None, min_length=1, max_length=5)


    @model_validator(mode='after')
    def validate_question_types(self):
        if self.entry_mode in ('chat', 'map_chat') and (self.exploration_mode != 'manual' or self.manual_flow != 'decomposition_first'):
            raise ValueError('会話からの開始は手動探索で利用できます。')
        if self.exploration_mode == 'manual' and self.manual_flow == 'decomposition_first':
            fixed_types = ['multiple_choice']
            if self.allowed_question_types is not None and self.allowed_question_types != fixed_types:
                raise ValueError('問題形式は4択問題に固定されています。')
            if self.answer_format != 'auto':
                raise ValueError('問題形式は4択問題に固定されています。')
            self.allowed_question_types = fixed_types
            return self
        if self.allowed_question_types is not None:
            if len(set(self.allowed_question_types)) != len(self.allowed_question_types):
                raise ValueError('回答形式は重複せずに指定してください。')
            if not set(self.allowed_question_types) & {'multiple_choice', 'yes_no'}:
                raise ValueError('事実・用語の確認用に、4択または正誤判断を1つ以上選択してください。')
        return self


class SelectConceptRequest(Model):
    """手動探索モードでの診断対象概念選択リクエスト"""
    concept_id: str


class AnswerRequest(Model):
    """問題に対するユーザー回答送信リクエスト（回答文字列、自己確信度、回答所要時間）"""
    question_id: str
    answer: str = Field(min_length=1, max_length=5000)
    user_confidence: Literal['high', 'medium', 'low'] | None = None
    answer_time_ms: int | None = Field(default=None, ge=0, le=86400000)
    immediate_feedback: bool = False
