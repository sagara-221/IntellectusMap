# 06. 概念選択・探索 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/select |
| 概要 | 知識ツリー上の特定の概念ノードを選択し、アクティブ状態にして該当ノードの診断問題を出題する |
| 認証 | 任意（セッション所有者またはゲスト所有） |
| リクエスト形式 | application/json |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ○ | `sess_` prefix | 診断セッションID |

### 2.2 リクエストボディ項目一覧

| フィールド名 | 型 | 必須 | 制約 | 説明 | 具体例 |
| --- | --- | --- | --- | --- | --- |
| `concept_id` | string | ○ | 1文字以上 | 選択して出題を開始する概念ノードID | `"c_diff_coeff"` |

#### リクエストボディ例
```json
{
  "concept_id": "c_diff_coeff"
}
```

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 選択成功 | ノードがアクティブ化され、問題が出題された |
| 400 Bad Request | リクエスト不正 | 概念ノードIDが未指定、または選択不可能な状態 |
| 404 Not Found | 未存在 | セッションまたは指定された `concept_id` が存在しない |
| 503 Service Unavailable | 生成エラー | LLMによる問題生成が失敗した場合 |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

本APIは更新後のセッション全体オブジェクト（`SessionDTO`）を返却する。主要項目の表は以下の通り。

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションID | `"sess_8f3a91b2c4e5"` |
| `active_concept_id` | string | ○ | **今回選択されアクティブ化された概念ノードID** | `"c_diff_coeff"` |
| `awaiting_selection` | boolean | ✕ | 選択待ち解除により `false` となる | `false` |
| `next_question` | object | ○ | **選択された概念ノードに対して新規生成された問題**（後述 3.2.1） | `{ ... }` |
| `knowledge_tree` | object | ✕ | 該当ノードの `status` が `"assessing"` に更新されたツリー | `{ ... }` |
| `learning_states` | object | ✕ | 概念ノード別の最新学習状態辞書 | `{ ... }` |
| `understanding_summaries`| object | ✕ | 各ノードの理解度集計サマリー | `{ ... }` |
| `revision` | integer | ✕ | 楽観ロック用リビジョン番号（インクリメントされる） | `1` |
| `questions_answered` | integer | ✕ | 現在の回答済み問題総数 | `0` |
| `complete` | boolean | ✕ | セッション完了フラグ | `false` |
| `error` | string | ○ | 問題生成失敗時のエラーメッセージ | `null` |

#### 3.2.1 `next_question`（出題問題オブジェクト）の項目一覧
出題中につき、正解 (`expected_answer`) や解説 (`answer_explanation`) は秘匿除外される。

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `question_id` | string | ✕ | 生成された問題の一意識別子 (`q_` prefix) | `"q_a1b2c3d4e5f6"` |
| `concept_id` | string | ✕ | 出題対象の概念ノードID | `"c_diff_coeff"` |
| `assessment_target_id` | string | ✕ | 評価対象の目標ID | `"t_coeff_1"` |
| `difficulty` | string | ✕ | 難易度 (`"basic"`, `"medium"`, `"advanced"`) | `"basic"` |
| `question_type` | string | ✕ | 問題形式 (`"multiple_choice"`, `"yes_no"` 等) | `"multiple_choice"` |
| `question_text` | string | ✕ | 出題本文（Markdown形式対応） | `"関数 f(x) = x^2 において..."` |
| `choices` | array of object | ○ | 選択式問題の選択肢一覧（後述 3.2.2） | `[ ... ]` |
| `origin_map_id` | string | ○ | 他マップからの引用出題時の元マップID | `null` |

#### 3.2.2 `choices` の要素項目
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `choice_id` | string | 選択肢の一意識別子 | `"c1"`, `"c2"`, `"c3"`, `"c4"` |
| `text` | string | 選択肢の表示テキスト | `"4"` |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "session_id": "sess_8f3a91b2c4e5",
  "theme": "微分法と導関数",
  "domain_context": "高校数学IIの微分基礎",
  "mode": "gemini",
  "exploration_mode": "manual",
  "manual_flow": "decomposition_first",
  "decomposition_max_depth": null,
  "initial_visible_depth": 1,
  "initial_generation_complete": true,
  "decomposition_statuses": {
    "c_diff_coeff": "ready"
  },
  "decomposition_depth_reason": null,
  "focused_path": [],
  "answer_format": "auto",
  "allowed_question_types": ["multiple_choice"],
  "reassessment_concept_id": null,
  "active_concept_id": "c_diff_coeff",
  "paused_concept_ids": [],
  "awaiting_selection": false,
  "created_at": "2026-10-04T12:00:00.000000+00:00",
  "revision": 1,
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
        "assessment_targets": [
          {
            "target_id": "t_coeff_1",
            "description": "極限による微分係数の計算",
            "knowledge_type": "calculation",
            "importance": "core",
            "prerequisite_target_ids": []
          }
        ],
        "child_candidates": [],
        "terminal_reason": null,
        "prerequisite_concept_ids": [],
        "parent_concept_id": "c_root",
        "depth": 1,
        "terminal_confirmed": false,
        "assessment_scope": "direct",
        "status": "assessing",
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
      "understanding_score": null,
      "diagnostic_confidence": 0.0,
      "status": "assessing",
      "questions_answered": 0,
      "correct_count": 0,
      "target_states": {},
      "detected_misconceptions": [],
      "evidence_ids": []
    }
  },
  "self_assessments": {},
  "understanding_summaries": {
    "c_diff_coeff": {
      "level": "unknown",
      "confidence_level": "low",
      "source": "default",
      "evidence_count": 0
    }
  },
  "pending_review": null,
  "review_history": [],
  "next_question": {
    "question_id": "q_2001",
    "concept_id": "c_diff_coeff",
    "assessment_target_id": "t_coeff_1",
    "difficulty": "basic",
    "question_type": "multiple_choice",
    "question_text": "関数 f(x) = x^2 において、x = 2 における微分係数 f'(2) の定義式に基づく極限計算の値として正しいものを選択せよ。",
    "choices": [
      { "choice_id": "c1", "text": "2" },
      { "choice_id": "c2", "text": "4" },
      { "choice_id": "c3", "text": "x" },
      { "choice_id": "c4", "text": "8" }
    ],
    "origin_map_id": null
  },
  "next_action": {
    "session_question_count": 0,
    "action": "assess",
    "concept_id": "c_diff_coeff",
    "question_requests": [],
    "expand_target_id": null,
    "reason_code": "DIRECT_ASSESSMENT"
  },
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
}
```

### 3.4 エラーレスポンス例 (404 Not Found)

```json
{
  "detail": "セッションまたは知識項目が見つかりません。"
}
```

## 4. 業務処理ロジック・仕様

1. **アクティブ化処理**:
   - 指定された `concept_id` が存在することを確認し、`session.active_concept_id` にセットする。
   - `awaiting_selection` フラグを `false` に切り替える。
2. **診断問題の生成またはプール取得**:
   - 既に問題プールにキャッシュが存在する場合は即座に取り出して `next_question` とする。
   - キャッシュがない場合は `QuestionAgent` (Gemini API) を呼び出し、該当ノードの評価目標に基づく4択問題を新規生成して出題する。
3. **ノードステータスの更新**:
   - 初回出題時、学習状態およびツリー内ノードの `status` を `"assessing"`（診断中）に更新する。
