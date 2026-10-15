# ==============================================================================
# マップドメインモデル定義
# 用途: 展開マップ（派生マップ）候補生成、マップ間リレーション、マップ更新リクエスト
# ==============================================================================
from __future__ import annotations

from pydantic import Field, model_validator

from app.models.domain import ConceptSpec, Model, uid


class DivergenceInput(Model):
    """展開マップ候補生成エージェントへの入力モデル"""
    knowledge_map_theme: str
    scope: str | None = None
    selected_concept: ConceptSpec
    concept_path: list[str] = Field(min_length=1)
    candidate_count: int = Field(ge=1, le=15)
    existing_map_themes: list[str] = Field(default_factory=list)
    previous_candidates: list[DivergenceCandidateDraft] = Field(default_factory=list)


class DivergenceCandidateDraft(Model):
    """LLMが生成する展開テーマ候補のドラフト"""
    name: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=80)
    relation: str = Field(min_length=1, max_length=500)
    reason: str = Field(min_length=1, max_length=1000)


class DivergenceOutput(Model):
    """展開候補生成エージェントの構造化出力モデル"""
    theme: str = Field(min_length=1)
    divergent_nodes: list[DivergenceCandidateDraft] = Field(min_length=1, max_length=15)

    @model_validator(mode='after')
    def unique_candidates(self):
        names = [item.name.casefold() for item in self.divergent_nodes]
        if len(names) != len(set(names)):
            raise ValueError('展開候補の名前が重複しています。')
        return self


class DivergenceCandidate(DivergenceCandidateDraft):
    """一意識別IDが付与された展開候補モデル"""
    id: str = Field(default_factory=lambda: uid('candidate'))


class DivergenceBatch(Model):
    """特定概念から生成された展開候補のバッチ管理モデル"""
    source_map_id: str
    source_concept_id: str
    source_concept_name: str
    candidates: list[DivergenceCandidate]


class KnowledgeMapRelation(Model):
    """マップ間の派生関係（リレーションシップ）モデル"""
    source_map_id: str
    source_concept_id: str
    target_map_id: str
    category: str
    relation: str
    reason: str


class MapUpdate(Model):
    """マップメタデータ更新リクエストモデル"""
    title: str = Field(min_length=1, max_length=300)
    scope: str | None = Field(default=None, max_length=12000)

