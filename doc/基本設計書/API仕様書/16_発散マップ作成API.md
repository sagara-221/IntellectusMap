# 16. 発散マップ作成 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/maps/{map_id}/concepts/{concept_id}/divergence/{candidate_id}/create |
| 概要 | 発散候補（candidate）の中から選択したテーマをもとに、派生マップを新規生成・構築し、元マップとの間に派生リレーションを記録する |
| 認証 | 不要（パブリック） |
| リクエスト形式 | application/json |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ○ | `sess_` prefix | 派生元の知識マップID |
| `concept_id` | string | ○ | 1文字以上 | 派生元となった概念ノードID |
| `candidate_id` | string | ○ | `candidate_` prefix | 発散候補生成APIで返却された候補ID |

### 2.2 クエリパラメータ / リクエストボディ
なし

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 作成成功 | 派生マップが正常に構築され、最新のマップ詳細情報が返却された |
| 404 Not Found | 未存在 | 指定されたマップ、概念ノード、または発散候補IDが存在しない |
| 503 Service Unavailable | 生成エラー | LLMによる初期ツリー分解処理のエラー |

### 3.2 レスポンスボディ項目一覧（新マップのMapDetailDTOオブジェクト）

本APIは新しく作成された派生マップの詳細データ（`MapDetailDTO`）を返却する。

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ✕ | 新規作成された派生マップID (`sess_` prefix) | `"sess_999999999999"` |
| `lineage_id` | string | ✕ | 元マップと同一のマップ系統グループID | `"lineage_1a2b3c4d"` |
| `title` | string | ✕ | 発散候補の名称（テーマ名） | `"微分を用いた力学運動方程式"` |
| `scope` | string | ○ | マップスコープ | `null` |
| `created_at` | string | ✕ | マップ作成日時 | `"2026-10-04T13:00:00+00:00"` |
| `updated_at` | string | ✕ | マップ更新日時 | `"2026-10-04T13:00:00+00:00"` |
| `stats` | object | ✕ | 派生マップの初期診断統計情報 | `{ ... }` |
| `origin` | object | ✕ | **派生元の詳細情報（後述 3.2.1）** | `{ ... }` |
| `session` | object | ✕ | **派生マップの診断セッションデータ（SessionDTO）**（初期分解されたツリーを含む） | `{ ... }` |
| `history` | array of object | ✕ | 診断履歴配列（作成直後は空配列 `[]`） | `[]` |

#### 3.2.1 `origin`（派生元リレーション情報）の項目一覧
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `source_map_id` | string | 派生元マップID | `"sess_8f3a91b2c4e5"` |
| `source_map_title` | string | 派生元マップのタイトル | `"微分法と導関数"` |
| `source_concept_id` | string | 派生元の概念ノードID | `"c_diff_coeff"` |
| `source_concept_name` | string | 派生元の概念名 | `"平均変化率と微分係数"` |
| `category` | string | 発散候補のカテゴリ分類 | `"物理・工学への応用"` |
| `relation` | string | 元概念との関係性説明 | `"瞬間の変化率としての微分が、速度や加速度の定義に直結する"` |
| `reason` | string | 派生マップ作成推奨理由 | `"数学的な極限の概念が物理現象と結びつくため"` |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "map_id": "sess_999999999999",
  "lineage_id": "lineage_1a2b3c4d",
  "title": "微分を用いた力学運動方程式",
  "scope": null,
  "created_at": "2026-10-04T13:00:00+00:00",
  "updated_at": "2026-10-04T13:00:00+00:00",
  "stats": {
    "explored_concepts": 3,
    "diagnosed_concepts": 0,
    "question_answers": 0,
    "survey_answers": 0,
    "weak_concepts": 0
  },
  "origin": {
    "source_map_id": "sess_8f3a91b2c4e5",
    "source_map_title": "微分法と導関数",
    "source_concept_id": "c_diff_coeff",
    "source_concept_name": "平均変化率と微分係数",
    "category": "物理・工学への応用",
    "relation": "瞬間の変化率としての微分が、速度や加速度の定義に直結する",
    "reason": "数学的な極限の概念が物理現象と結びつくため"
  },
  "session": {
    "session_id": "sess_999999999999",
    "theme": "微分を用いた力学運動方程式",
    "domain_context": null,
    "mode": "gemini",
    "exploration_mode": "manual",
    "manual_flow": "decomposition_first",
    "decomposition_max_depth": null,
    "initial_visible_depth": 1,
    "initial_generation_complete": true,
    "decomposition_statuses": {},
    "decomposition_depth_reason": null,
    "focused_path": [],
    "answer_format": "auto",
    "allowed_question_types": ["multiple_choice"],
    "reassessment_concept_id": null,
    "active_concept_id": null,
    "paused_concept_ids": [],
    "awaiting_selection": true,
    "created_at": "2026-10-04T13:00:00+00:00",
    "revision": 0,
    "knowledge_tree": {
      "concept_id": "c_physics_root",
      "concept_name": "微分を用いた力学運動方程式",
      "description": "運動の解析における微分の適用",
      "granularity": "broad",
      "knowledge_type": "conceptual",
      "assessment_targets": [],
      "child_candidates": [],
      "terminal_reason": null,
      "prerequisite_concept_ids": [],
      "parent_concept_id": null,
      "depth": 0,
      "terminal_confirmed": false,
      "assessment_scope": "direct",
      "status": "not_assessed",
      "origin": "generated",
      "child_nodes": [
        {
          "concept_id": "c_velocity_accel",
          "concept_name": "位置・速度・加速度の微分関係",
          "description": "位置の1階微分が速度、2階微分が加速度となる関係性",
          "granularity": "medium",
          "knowledge_type": "conceptual",
          "assessment_targets": [
            {
              "target_id": "t_va_1",
              "description": "位置関数 x(t) から速度関数 v(t) を導出できる",
              "knowledge_type": "calculation",
              "importance": "core",
              "prerequisite_target_ids": []
            }
          ],
          "child_candidates": [],
          "terminal_reason": null,
          "prerequisite_concept_ids": [],
          "parent_concept_id": "c_physics_root",
          "depth": 1,
          "terminal_confirmed": false,
          "assessment_scope": "direct",
          "status": "not_assessed",
          "origin": "generated",
          "child_nodes": []
        }
      ]
    },
    "concept_edges": [],
    "concept_redirects": {},
    "canonical_refs": {},
    "cross_map_matching": false,
    "learning_states": {
      "c_velocity_accel": {
        "concept_id": "c_velocity_accel",
        "understanding_score": null,
        "diagnostic_confidence": 0.0,
        "status": "not_assessed",
        "questions_answered": 0,
        "correct_count": 0,
        "target_states": {},
        "detected_misconceptions": [],
        "evidence_ids": []
      }
    },
    "self_assessments": {},
    "understanding_summaries": {
      "c_velocity_accel": {
        "level": "unknown",
        "confidence_level": "low",
        "source": "default",
        "evidence_count": 0
      }
    },
    "pending_review": null,
    "review_history": [],
    "next_question": null,
    "next_action": null,
    "evaluation": null,
    "updated_learning_state": null,
    "evidence": [],
    "question_history": [],
    "policy_history": [],
    "questions_answered": 0,
    "max_total_questions": null,
    "complete": false,
    "stop_reason": null,
    "error": null,
    "metrics": {
      "display_only_concepts": 0,
      "unassessed_concepts": 1,
      "first_weak_question": null,
      "first_weak_answer_time_ms": null,
      "written_answers": 0,
      "ungradable_answers": 0,
      "answer_time_ms": 0,
      "assessed_concepts": 0,
      "weak_concepts": 0
    }
  },
  "history": []
}
```

### 3.4 エラーレスポンス例 (404 Not Found)

```json
{
  "detail": "指定された発散候補（candidate_id）が見つかりません。"
}
```

## 4. 業務処理ロジック・仕様

1. **冪等性（既存派生マップの再利用）**:
   - 当該 `candidate_id` に対して既に派生マップが作成済み（`target_map_id` が設定されている）である場合、重複して新規作成を行わず、既存の派生マップデータを即座に返却する。
2. **系統（Lineage）の継承**:
   - 新規作成される派生マップは、元マップと同じ `lineage_id` を自動的に継承し、マップ系統図（Lineage Graph）上で連結される。
3. **マップ間リレーションの登録**:
   - `knowledge_map_relations` テーブルに `source_map_id`, `target_map_id`, `source_concept_id`, `category`, `relation`, `reason` を永続化し、相互リンクを形成する。
