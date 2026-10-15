"""知識分解（Knowledge Decomposition）エージェントモジュール。

広範なテーマや概念を、診断可能な最小単位の知識・評価目標（assessment targets）へと
段階的に細分化・構造化する。観点計画（coverage_plan）と子ノード生成（decomposition）の
2段階生成制御を行う。
"""
import logging
from functools import lru_cache
from pydantic import Field, create_model, model_validator

from app.models.domain import AuditedDecomposition, ConceptSpec, Decomposition, DecompositionInput, FacetPlan
from app.llm.base import LLMError, LLMService


logger = logging.getLogger(__name__)


@lru_cache(maxsize=20)
def decomposition_schemas(minimum: int, maximum: int):
    """Apply the request's limits inside LLM validation, so its repair retry runs."""
    bounded = create_model('BoundedDecomposition', __base__=Decomposition,
        child_nodes=(list[ConceptSpec], Field(min_length=minimum, max_length=maximum)))
    audited = create_model('BoundedAuditedDecomposition', __base__=AuditedDecomposition,
        decomposition=(bounded, ...))
    return bounded, audited


@lru_cache(maxsize=128)
def planned_decomposition_schema(minimum: int, maximum: int, facet_names: tuple[str, ...]):
    """Validate the actual plan inside the provider's JSON repair loop."""
    _, audited = decomposition_schemas(minimum, maximum)

    @model_validator(mode='after')
    def matches_plan(self):
        # Empty deep decompositions still go through the existing replan/terminal
        # decision, rather than fabricating children just to satisfy coverage.
        if not self.decomposition.child_nodes:
            return self
        actual = {entry.facet_name for entry in self.coverage}
        expected = set(facet_names)
        if actual != expected:
            raise ValueError(
                f'coverage must contain every planned facet name exactly once. '
                f'Missing: {sorted(expected - actual)}; unexpected: {sorted(actual - expected)}. '
                f'Use these exact names: {list(facet_names)}. '
                f'Facet count is independent of child count (maximum {maximum}). '
                'One child may cover multiple related facets; keep a separate coverage entry for each facet. '
                'Ensure the child descriptions/assessment targets actually address those facets.')
        return self

    return create_model('PlannedAuditedDecomposition', __base__=audited,
                        __validators__={'matches_plan': matches_plan})


class DecompositionAgent:
    """知識マップのノード分割・下位概念生成を担当するエージェント。
    
    1. 観点計画（coverage_plan）で必要な切り口を事前計画
    2. 計画された観点に沿って子ノード（decomposition）を生成
    3. 不整合があれば再計画・リトライを行う2段階生成フローを採用。
    """
    def __init__(self, llm: LLMService):
        self.llm = llm

    async def run(self, request: DecompositionInput) -> Decomposition:
        """指定された概念（または全体テーマ）を分解し、子ノード群を生成する"""
        initial = request.purpose == 'initial_decomposition'
        output_schema, _ = decomposition_schemas(
            3 if initial else 0, min(request.max_children, 10))

        def normalize_plan(candidate):
            # Display depth is application policy, not an AI decision. This
            # legacy metadata must never reject an otherwise useful deep plan.
            return candidate.model_copy(update={'suggested_initial_depth': 2 if initial else None})

        planned = getattr(self.llm, 'requires_coverage_plan', False)
        if planned:
            # 1. 最小観点数の決定（初回分解は3件、広域・中域概念は2件、詳細概念は1件）
            if initial:
                minimum_facets = 3
            elif request.target_concept and request.target_concept.granularity in ('broad', 'medium'):
                minimum_facets = 2
            else:
                minimum_facets = 1
            request = request.model_copy(update={'minimum_facets': minimum_facets})
            
            # 2. 観点計画（coverage_plan）の生成
            plan = await self.llm.generate('coverage_plan', request, FacetPlan, .2)
            # Older planners used depth=1 to also signal a broad theme. Keep
            # their coverage checks, while fixing the actual display depth at 2.
            broad_initial = initial and plan.suggested_initial_depth == 1
            plan = normalize_plan(plan)
            target = request.target_concept
            # 概念的・広域な項目で性急に終了（terminal）しようとした場合は具体化を強制して再計画
            if plan.strategy == 'terminal' and not request.force_concretize and target and (
                    target.knowledge_type == 'conceptual' or target.granularity in ('broad', 'medium')):
                request = request.model_copy(update={'force_concretize': True})
                plan = normalize_plan(await self.llm.generate('coverage_plan', request, FacetPlan, .2))
            if broad_initial and request.max_children >= 6 and len(plan.facets) < 6:
                request = request.model_copy(update={'minimum_facets': 6})
                plan = normalize_plan(await self.llm.generate('coverage_plan', request, FacetPlan, .2))

            def check_plan(candidate: FacetPlan):
                """観点計画（深さ・戦略・観点数）の妥当性を検証"""
                if initial and candidate.strategy != 'breadth':
                    raise LLMError('初回の観点計画が不足しています。再試行してください。')
                if candidate.strategy != 'terminal':
                    needed = (6 if broad_initial
                              and request.max_children >= 6 else request.minimum_facets)
                    if len(candidate.facets) < needed:
                        raise LLMError('分解に必要な観点が不足しています。再試行してください。')

            def terminal_result(candidate: FacetPlan) -> Decomposition:
                """これ以上分解できない末端ノード（子ノード0件）の結果を構築"""
                if not target or not candidate.terminal_reason:
                    raise LLMError('分解を終了する理由が不明です。再試行してください。')
                root = target.model_copy(deep=True, update={
                    'granularity': 'narrow', 'child_candidates': [],
                    'terminal_reason': candidate.terminal_reason})
                return Decomposition(root_concept=root, child_nodes=[],
                                     decomposition_summary=candidate.terminal_reason)

            def inconsistency(candidate: FacetPlan, generated: AuditedDecomposition):
                """計画された観点と生成された子ノードの整合性を検査（不整合があれば種類を返す）"""
                if not generated.decomposition.child_nodes:
                    return 'empty_children'
                if {entry.facet_name for entry in generated.coverage} != {facet.name for facet in candidate.facets}:
                    return 'missing_facet_coverage'
                return None

            check_plan(plan)
            if plan.strategy == 'terminal':
                # 計画段階で「これ以上分解不可」と判定された場合、無駄な分解呼出をスキップして末端確定
                result = terminal_result(plan)
            else:
                # 3. 計画された観点に基づき、子ノード分解（decomposition）を実行（最大2回試行）
                feedback = None
                saw_children = False
                for attempt in range(2):
                    response = await self.llm.generate('decomposition',
                        request.model_copy(update={'coverage_plan': plan,
                                                   'generation_feedback': feedback}),
                        planned_decomposition_schema(3 if initial else 0, min(request.max_children, 10),
                                                     tuple(facet.name for facet in plan.facets)), .2)
                    saw_children = saw_children or bool(response.decomposition.child_nodes)
                    feedback = inconsistency(plan, response)
                    if feedback is None:
                        break
                    logger.warning('decomposition_inconsistent concept_id=%s strategy=%s kind=%s facets=%d children=%d attempt=%d',
                                   request.parent_concept_id, plan.strategy, feedback,
                                   len(plan.facets), len(response.decomposition.child_nodes), attempt + 1)
                if feedback is not None:
                    # 4. 2回試行しても不整合が残る場合、観点計画自体の再検討（reconsider_plan）を実施
                    plan = normalize_plan(await self.llm.generate('coverage_plan',
                        request.model_copy(update={'coverage_plan': plan,
                                                   'generation_feedback': feedback,
                                                   'reconsider_plan': True,
                                                   'force_concretize': request.force_concretize or
                                                       (not initial and feedback == 'empty_children')}),
                        FacetPlan, .2))
                    check_plan(plan)
                    if plan.strategy == 'terminal':
                        if saw_children:
                            raise LLMError('生成した子項目と観点の対応を確認できませんでした。再試行してください。')
                        result = terminal_result(plan)
                    else:
                        # 再検討された観点計画で再度分解を実行
                        response = await self.llm.generate('decomposition',
                            request.model_copy(update={'coverage_plan': plan,
                                                       'generation_feedback': feedback}),
                            planned_decomposition_schema(3 if initial else 0, min(request.max_children, 10),
                                                         tuple(facet.name for facet in plan.facets)), .2)
                        feedback = inconsistency(plan, response)
                        if feedback is not None:
                            raise LLMError('計画した観点に沿う子項目を生成できませんでした。再試行してください。')
                        result = response.decomposition
                else:
                    result = response.decomposition
                if result.child_nodes and initial:
                    result.suggested_initial_depth = plan.suggested_initial_depth
                    if broad_initial and request.max_children >= 6 and len(result.child_nodes) < 6:
                        raise LLMError('広いテーマの主要項目が不足しています。再試行してください。')
                    if broad_initial and len(plan.facets) <= request.max_children:
                        if len(result.child_nodes) < len(plan.facets):
                            raise LLMError('広いテーマの観点が独立した主要項目になっていません。再試行してください。')
                        counts = {identifier: sum(identifier in link.child_concept_ids
                            for link in response.coverage) for identifier in
                            (node.concept_id for node in result.child_nodes)}
                        if any(not any(counts[identifier] == 1 for identifier in link.child_concept_ids)
                               for link in response.coverage):
                            raise LLMError('異なる観点が汎用的な主要項目にまとめられています。再試行してください。')
        else:
            # 観点計画が不要なモデル・設定の場合は直接1回で分解を実行
            result = await self.llm.generate('decomposition', request, output_schema, .2)

        result = result.model_copy(update={'suggested_initial_depth': 2 if initial else None})

        # 5. 最終バリデーション（子ノード件数、終了理由、概念IDの重複、前提知識の妥当性）
        if len(result.child_nodes) > request.max_children or (request.purpose == 'initial_decomposition' and len(result.child_nodes) < 3):
            raise LLMError('知識分解の項目数が範囲外です。再試行してください。')
        if request.purpose != 'initial_decomposition' and not result.child_nodes:
            root = result.root_concept
            if (root.concept_id != request.parent_concept_id or root.granularity != 'narrow'
                    or root.child_candidates or not root.terminal_reason):
                raise LLMError('分解を終了する理由が不明です。再試行してください。')
        existing = set(request.existing_concept_ids)
        child_ids = {n.concept_id for n in result.child_nodes}
        if child_ids & existing:
            raise LLMError('知識分解のIDが重複しています。再試行してください。')
        valid = existing | child_ids | {result.root_concept.concept_id}
        if any(p not in valid or p == n.concept_id for n in result.child_nodes for p in n.prerequisite_concept_ids):
            raise LLMError('前提知識の参照が不正です。再試行してください。')
        return result
