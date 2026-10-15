"""Conversation evidence is stored independently of surveys and question answers."""
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4
from pydantic import BaseModel, ConfigDict, Field, model_validator


def identifier(prefix):
    return f'{prefix}_{uuid4().hex[:16]}'


class ChatModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class ChatMessage(ChatModel):
    message_id: str
    role: Literal['user', 'assistant']
    content: str
    conversation_id: str = 'conversation_initial'
    status: Literal['pending', 'complete', 'failed'] = 'complete'
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Citation(ChatModel):
    message_id: str
    quote: str = Field(min_length=1, max_length=1500)


class ChatJudgment(ChatModel):
    concept_id: str
    target_id: str
    score: float = Field(ge=0, le=1)
    confidence: float = Field(gt=0, le=1)
    kind: Literal['demonstrated', 'gap', 'self_report']
    citations: list[Citation] = Field(min_length=1, max_length=4)
    demonstrated: list[str] = Field(default_factory=list, max_length=5)
    missing: list[str] = Field(default_factory=list, max_length=5)
    reason: str = Field(min_length=1, max_length=1000)


class ChatObservation(ChatJudgment):
    observation_id: str = Field(default_factory=lambda: identifier('chat_ev'))
    turn_id: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ChatAssessment(ChatModel):
    judgments: list[ChatJudgment] = Field(default_factory=list, max_length=24)
    focus_concept_id: str | None = None
    conversation_guidance: str = Field(default='', max_length=1200)
    structure_needed: bool = False


class ChatAddition(ChatModel):
    parent_concept_id: str
    concept_name: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=1000)
    citations: list[Citation] = Field(min_length=1, max_length=3)


class ChatStructurePlan(ChatModel):
    links: list['ChatUnitLink'] = Field(default_factory=list, max_length=80)
    expand_concept_ids: list[str] = Field(default_factory=list, max_length=10)
    additions: list[ChatAddition] = Field(default_factory=list, max_length=10)


class ChatUnitLink(ChatModel):
    unit_id: str
    concept_id: str
    needs_detail: bool = False
    reason: str = Field(min_length=1, max_length=600)


class ExperienceUnit(ChatModel):
    topic: str = Field(min_length=1, max_length=120)
    statement: str = Field(min_length=1, max_length=1000)
    kind: Literal['experience', 'explanation', 'gap', 'mention']
    citations: list[Citation] = Field(min_length=1, max_length=4)
    granularity: Literal['domain', 'knowledge', 'specific'] = 'knowledge'
    parent_topic: str | None = Field(default=None, max_length=120)


class StoredExperience(ExperienceUnit):
    unit_id: str
    turn_id: str
    source_chunk: int = 0
    source_order: int = 0


class EvidenceQueueItem(ChatModel):
    """Keep the source unit and its correspondence after removing it from active work."""
    unit_id: str
    status: Literal['pending', 'waiting', 'insufficient', 'resolved', 'ignored'] = 'pending'
    matched_concept_ids: list[str] = Field(default_factory=list)
    detail_concept_ids: list[str] = Field(default_factory=list)
    added_concept_ids: list[str] = Field(default_factory=list)
    pending_addition_keys: list[str] = Field(default_factory=list)
    last_checked_graph: str = ''
    last_checked_idle: bool = False
    reason: str = ''
    processing_error: str | None = None
    failed_stage: str | None = None
    pending_expansion_ids: list[str] = Field(default_factory=list)


class ChatExtraction(ChatModel):
    units: list[ExperienceUnit] = Field(default_factory=list, max_length=40)


class ExtractionInput(ChatModel):
    theme: str
    domain_context: str | None = None
    message_id: str
    text: str
    section: list[str] = Field(default_factory=list)


class ChatPlanReview(ChatModel):
    approved_expansions: list[str] = Field(default_factory=list, max_length=10)
    approved_additions: list[int] = Field(default_factory=list, max_length=10)
    deferred_reasons: list[str] = Field(default_factory=list, max_length=20)


class ChatJob(ChatModel):
    turn_id: str
    status: Literal['queued', 'running', 'complete', 'failed'] = 'queued'
    phase: Literal['extracting', 'planning', 'updating', 'assessing', 'complete'] = 'extracting'
    total_chunks: int = 0
    completed_chunks: list[int] = Field(default_factory=list)
    planning_complete: bool = False
    planned_expansions: list[str] = Field(default_factory=list)
    planned_additions: list[ChatAddition] = Field(default_factory=list)
    planned_links: list[ChatUnitLink] = Field(default_factory=list)
    related_concept_ids: list[str] = Field(default_factory=list)
    updated_concept_ids: list[str] = Field(default_factory=list)
    applied_additions: list[str] = Field(default_factory=list)
    deferred_reasons: list[str] = Field(default_factory=list)
    error: str | None = None
    failed_unit_ids: list[str] = Field(default_factory=list)
    completed_expansions: list[str] = Field(default_factory=list)
    pending_expansions: list[str] = Field(default_factory=list)


class ChatRoutingRecord(ChatModel):
    context_hash: str
    plan: ChatStructurePlan


class ChatInput(ChatModel):
    theme: str
    domain_context: str | None = None
    messages: list[ChatMessage]
    concepts: list[dict]
    focus_concept_id: str | None = None
    previous_guidance: str = ''
    assessment: ChatAssessment | None = None
    purpose: Literal['current_turn', 'new_nodes', 'structure', 'reply', 'evidence'] = 'current_turn'
    experience_units: list[StoredExperience] = Field(default_factory=list)
    processing_topics: list[str] = Field(default_factory=list)
    proposed_plan: ChatStructurePlan | None = None
    reconciliation: bool = False
    allow_additions: bool = True
    exploration_topics: list[dict] = Field(default_factory=list)
    unit_concept_ids: dict[str, list[str]] = Field(default_factory=dict)


class ChatRequest(ChatModel):
    message_id: str = Field(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')
    content: str = Field(min_length=1, max_length=100000)
    concept_id: str | None = None
    conversation_id: str | None = None


class NewConversationRequest(ChatModel):
    conversation_id: str = Field(default_factory=lambda: identifier('conversation'),
                                min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')


class ChatConversation(ChatModel):
    conversation_id: str
    title: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ChatState(ChatModel):
    current_conversation_id: str = 'conversation_initial'
    conversations: list[ChatConversation] = Field(default_factory=list)
    messages: list[ChatMessage] = Field(default_factory=list)
    observations: list[ChatObservation] = Field(default_factory=list)
    focus_concept_id: str | None = None
    conversation_guidance: str = ''
    foreground_turn_id: str | None = None
    background_turn_id: str | None = None
    background_status: Literal['idle', 'queued', 'running', 'failed'] = 'idle'
    background_error: str | None = None
    created_concept_ids: list[str] = Field(default_factory=list)
    generating_concept_ids: list[str] = Field(default_factory=list)
    jobs: list[ChatJob] = Field(default_factory=list)
    experience_units: list[StoredExperience] = Field(default_factory=list)
    evidence_queue: list[EvidenceQueueItem] = Field(default_factory=list)
    pending_node_ids: list[str] = Field(default_factory=list)
    failed_node_ids: list[str] = Field(default_factory=list)
    reconciliation_requested: bool = False
    reconciliation_phase: Literal['idle', 'waiting', 'matching', 'assessing', 'adding'] = 'idle'
    opened_concept_ids: list[str] = Field(default_factory=list)
    timings: dict[str, float] = Field(default_factory=dict)
    routing_records: dict[str, ChatRoutingRecord] = Field(default_factory=dict)
    assessment_records: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode='after')
    def ensure_conversations(self):
        # 旧記録の発言・根拠のIDを変更せず、最初の会話として読み込む。
        known = {item.conversation_id for item in self.conversations}
        for conversation_id in dict.fromkeys([*(item.conversation_id for item in self.messages),
                                              self.current_conversation_id]):
            if conversation_id in known:
                continue
            first = next((item for item in self.messages if item.conversation_id == conversation_id), None)
            self.conversations.append(ChatConversation(conversation_id=conversation_id,
                title=f'会話{len(self.conversations)+1}',
                **({'created_at': first.created_at} if first else {})))
            known.add(conversation_id)
        return self
