# 18. マップ詳細取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/maps/{map_id} |
| 概要 | 指定された知識マップの詳細情報、現在の診断セッション状態（ツリー構造・学習状態）、および出題・自己評価の全履歴を取得する |
| 認証 | 不要（パブリック） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ○ | `sess_` prefix | 取得対象の知識マップID（セッションIDと同一） |

### 2.2 クエリパラメータ / リクエストボディ
なし

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | 指定されたマップの詳細データが正常に取得された |
| 404 Not Found | 未存在 | 指定された `map_id` のマップが存在しない |

### 3.2 レスポンスボディ項目一覧（MapDetailDTOオブジェクト）

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ✕ | 知識マップID | `"sess_8f3a91b2c4e5"` |
| `lineage_id` | string | ✕ | 所属するマップ系統グループID | `"lineage_1a2b3c4d"` |
| `title` | string | ✕ | マップのタイトル・テーマ名 | `"微分法と導関数"` |
| `scope` | string | ○ | スコープ・補足説明文 | `"高校数学IIの微分基礎"` |
| `created_at` | string | ✕ | 作成日時（ISO 8601 UTC） | `"2026-10-04T12:00:00+00:00"` |
| `updated_at` | string | ✕ | 最終更新日時（ISO 8601 UTC） | `"2026-10-04T12:30:00+00:00"` |
| `stats` | object | ✕ | マップ内の診断統計情報（探索概念数、苦手数など） | `{ ... }` |
| `origin` | object | ○ | 派生元情報（派生作成されたマップのみ、それ以外はnull） | `{ ... }` または `null` |
| `session` | object | ✕ | **診断セッション全体データ（SessionDTO）**（ツリー、学習状態、出題状態等） | `{ ... }` |
| `history` | array of object | ✕ | **時系列の全出題回答・自己評価履歴配列**（後述 3.2.1） | `[ ... ]` |

#### 3.2.1 `history` の各要素（HistoryEventオブジェクト）の項目一覧
出題回答イベント（`type: "question"`）または自己評価イベント（`type: "self_assessment"`）が格納される。

##### A. 問題回答イベント (`type: "question"`)
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `type` | string | ✕ | イベント種別（`"question"` 固定） | `"question"` |
| `at` | string | ✕ | 回答実行日時（ISO 8601 UTC） | `"2026-10-04T12:05:00+00:00"` |
| `map_id` | string | ✕ | マップID | `"sess_8f3a91b2c4e5"` |
| `concept_id` | string | ✕ | 出題対象となった概念ノードID | `"c_diff_coeff"` |
| `concept_name` | string | ✕ | 出題対象の概念名 | `"平均変化率と微分係数"` |
| `question` | string | ✕ | 出題された問題本文 | `"関数 f(x) = x^2 において..."` |
| `user_answer` | string | ✕ | 学習者の回答テキスト（選択肢テキスト） | `"4"` |
| `result` | string | ✕ | 採点結果 (`"correct"`, `"incorrect"`, 等) | `"correct"` |
| `target` | string | ✕ | 評価対象となった目標の説明 | `"極限による微分係数の計算"` |
| `correct_answer` | string | ✕ | 正解の選択肢テキスト | `"4"` |
| `answer_explanation` | string | ✕ | 問題の解説テキスト | `"f'(2) = lim_{h->0} ..."` |
| `demonstrated_knowledge`| array of string | ✕ | 実証された知識一覧 | `["微分係数の極限計算"]` |
| `missing_knowledge` | array of string | ✕ | 不足していた知識一覧 | `[]` |
| `understanding_before` | float | ○ | 回答前の理解度スコア | `null` |
| `understanding_after` | float | ○ | 回答後の理解度スコア | `1.0` |
| `origin_map_id` | string | ○ | 他マップからの共有回答の場合の元マップID | `null` |

##### B. 自己評価イベント (`type: "self_assessment"`)
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `type` | string | ✕ | イベント種別（`"self_assessment"` 固定） | `"self_assessment"` |
| `at` | string | ✕ | 自己評価日時（ISO 8601 UTC） | `"2026-10-04T12:10:00+00:00"` |
| `map_id` | string | ✕ | マップID | `"sess_8f3a91b2c4e5"` |
| `concept_id` | string | ✕ | 自己評価対象の概念ノードID | `"c_deriv_func"` |
| `concept_name` | string | ✕ | 概念名 | `"導関数と基本公式"` |
| `level` | string | ✕ | 自己申告レベル (`"high"`, `"medium"`, `"low"`, `"unsure"`) | `"high"` |
| `origin_map_id` | string | ○ | 元マップID | `null` |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "map_id": "sess_8f3a91b2c4e5",
  "lineage_id": "lineage_1a2b3c4d",
  "title": "微分法と導関数",
  "scope": "高校数学IIの微分基礎",
  "created_at": "2026-10-04T12:00:00+00:00",
  "updated_at": "2026-10-04T12:30:00+00:00",
  "stats": {
    "explored_concepts": 2,
    "diagnosed_concepts": 1,
    "question_answers": 1,
    "survey_answers": 0,
    "weak_concepts": 0
  },
  "origin": null,
  "session": {
    "session_id": "sess_8f3a91b2c4e5",
    "theme": "微分法と導関数",
    "domain_context": "高校数学IIの微分基礎",
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
    "created_at": "2026-10-04T12:00:00+00:00",
    "revision": 2,
    "knowledge_tree": {
      "concept_id": "c_root",
      "concept_name": "微分法と導関数",
      "description": "関数の変化率と導関数の基礎",
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
          "concept_id": "c_diff_coeff",
          "concept_name": "平均変化率と微分係数",
          "description": "極限操作による瞬間変化率",
          "granularity": "medium",
          "knowledge_type": "conceptual",
          "assessment_targets": [],
          "child_candidates": [],
          "terminal_reason": null,
          "prerequisite_concept_ids": [],
          "parent_concept_id": "c_root",
          "depth": 1,
          "terminal_confirmed": false,
          "assessment_scope": "direct",
          "status": "mastered",
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
      "c_diff_coeff": {
        "concept_id": "c_diff_coeff",
        "understanding_score": 1.0,
        "diagnostic_confidence": 0.8,
        "status": "mastered",
        "questions_answered": 1,
        "correct_count": 1,
        "target_states": {},
        "detected_misconceptions": [],
        "evidence_ids": ["ev_1"]
      }
    },
    "self_assessments": {},
    "understanding_summaries": {
      "c_diff_coeff": {
        "level": "high",
        "confidence_level": "high",
        "source": "diagnostic",
        "evidence_count": 1
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
    "questions_answered": 1,
    "max_total_questions": null,
    "complete": false,
    "stop_reason": null,
    "error": null,
    "metrics": {
      "display_only_concepts": 0,
      "unassessed_concepts": 0,
      "first_weak_question": null,
      "first_weak_answer_time_ms": null,
      "written_answers": 0,
      "ungradable_answers": 0,
      "answer_time_ms": 12000,
      "assessed_concepts": 1,
      "weak_concepts": 0
    }
  },
  "history": [
    {
      "type": "question",
      "at": "2026-10-04T12:05:00+00:00",
      "map_id": "sess_8f3a91b2c4e5",
      "concept_id": "c_diff_coeff",
      "concept_name": "平均変化率と微分係数",
      "question": "関数 f(x) = x^2 において、x = 2 における微分係数 f'(2) の値として正しいものを選択せよ。",
      "user_answer": "4",
      "result": "correct",
      "target": "極限による微分係数の計算",
      "correct_answer": "4",
      "answer_explanation": "f'(2) = lim_{h->0} ((2+h)^2 - 4)/h = 4",
      "demonstrated_knowledge": ["極限計算による微分係数の導出"],
      "missing_knowledge": [],
      "understanding_before": null,
      "understanding_after": 1.0,
      "origin_map_id": null
    }
  ]
}
```

### 3.4 エラーレスポンス例 (404 Not Found)

```json
{
  "detail": "指定されたマップが見つかりません。"
}
```

## 4. 業務処理ロジック・仕様

1. **セッションデータと履歴の統合**:
   - リポジトリからマップメタデータ、診断セッションデータ（`public(session)`）、およびエビデンス・自己評価から復元した時系列履歴リスト（`history`）を統合して返却する。
2. **履歴の降順整列**:
   - `history` 配列は `at`（実行日時）の新しい順にソートされて返却される。
