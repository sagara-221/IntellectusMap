# 14. 概念手動追加 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/concepts |
| 概要 | ユーザーが任意の親概念ノードを指定し、新しい概念ノードを手動でツリーに追加する |
| 認証 | 任意（セッション所有者またはゲスト所有） |
| リクエスト形式 | application/json |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ○ | `sess_` prefix | 診断セッションID |

### 2.2 リクエストボディ項目一覧

| フィールド名 | 型 | 必須 | デフォルト値 | 制約・許容値 | 説明 | 具体例 |
| --- | --- | --- | --- | --- | --- | --- |
| `parent_concept_id` | string | ○ | なし | 1文字以上 | 親となる既存の概念ノードID | `"c_diff_coeff"` |
| `concept_name` | string | ○ | なし | 1〜120文字 | 追加する新しい概念の名称 | `"接線の傾きの幾何学的解釈"` |
| `note` | string | 任意 | `null` | 最大1000文字 | 概念の補足説明・ユーザーメモ | `"図形的なイメージを整理したい"` |

#### リクエストボディ例
```json
{
  "parent_concept_id": "c_diff_coeff",
  "concept_name": "接線の傾きの幾何学的解釈",
  "note": "図形的なイメージを整理したい"
}
```

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 追加成功 | 概念ノードが正常に生成・追加され、更新後のセッション状態が返却された |
| 400 Bad Request | リクエスト不正 | 必須項目欠落、親ノードが末端制限に達している等 |
| 404 Not Found | 未存在 | セッションまたは `parent_concept_id` が存在しない |
| 503 Service Unavailable | 生成エラー | LLMによる追加ノードの評価目標生成エラー |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

本APIは更新後のセッション全体オブジェクト（`SessionDTO`）を返却する。

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションID |
| `knowledge_tree` | object | ✕ | **手動追加されたノード（`origin: "user_added"`）を含む最新ツリー**（後述 3.2.1） |
| `learning_states` | object | ✕ | 追加されたノードの初期学習状態（`status: "not_assessed"`）が登録 |
| `understanding_summaries`| object | ✕ | 追加されたノードの初期サマリー（`level: "unknown"`）が登録 |
| `revision` | integer | ✕ | 更新に伴いインクリメントされたリビジョン番号 |

#### 3.2.1 手動追加された概念ノードの項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `concept_id` | string | ✕ | 自動生成されたノードID (`c_` prefix) | `"c_user_3f4e5a"` |
| `concept_name` | string | ✕ | ユーザーが入力した概念名 | `"接線の傾きの幾何学的解釈"` |
| `description` | string | ✕ | 入力内容に基づきAIが自動補完した解説文 | `"曲線上の1点における接線の傾きと..."` |
| `parent_concept_id` | string | ✕ | 指定した親ノードID | `"c_diff_coeff"` |
| `depth` | integer | ✕ | 親ノードのdepth + 1 | `2` |
| `origin` | string | ✕ | **手動追加を示す `"user_added"`** | `"user_added"` |
| `user_note` | string | ○ | ユーザーが入力したメモ（リクエストの `note`） | `"図形的なイメージを整理したい"` |
| `assessment_targets` | array of object | ✕ | AIが自動立案した評価目標リスト | `[ ... ]` |
| `status` | string | ✕ | 初期値 `"not_assessed"` | `"not_assessed"` |

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
  "decomposition_statuses": {},
  "decomposition_depth_reason": null,
  "focused_path": [],
  "answer_format": "auto",
  "allowed_question_types": ["multiple_choice"],
  "reassessment_concept_id": null,
  "active_concept_id": null,
  "paused_concept_ids": [],
  "awaiting_selection": true,
  "created_at": "2026-10-04T12:00:00.000000+00:00",
  "revision": 5,
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
        "status": "assessing",
        "origin": "generated",
        "child_nodes": [
          {
            "concept_id": "c_user_3f4e5a",
            "concept_name": "接線の傾きの幾何学的解釈",
            "description": "曲線上の1点における接線の傾きと微分係数の関係",
            "granularity": "narrow",
            "knowledge_type": "conceptual",
            "assessment_targets": [
              {
                "target_id": "t_geom_1",
                "description": "接線の傾きと微分係数が一致することを幾何学的に説明できる",
                "knowledge_type": "conceptual",
                "importance": "core",
                "prerequisite_target_ids": []
              }
            ],
            "child_candidates": [],
            "terminal_reason": null,
            "prerequisite_concept_ids": [],
            "parent_concept_id": "c_diff_coeff",
            "depth": 2,
            "terminal_confirmed": false,
            "assessment_scope": "direct",
            "status": "not_assessed",
            "origin": "user_added",
            "user_note": "図形的なイメージを整理したい",
            "child_nodes": []
          }
        ]
      }
    ]
  },
  "concept_edges": [],
  "concept_redirects": {},
  "canonical_refs": {},
  "cross_map_matching": false,
  "learning_states": {
    "c_user_3f4e5a": {
      "concept_id": "c_user_3f4e5a",
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
    "c_user_3f4e5a": {
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
  "questions_answered": 1,
  "max_total_questions": null,
  "complete": false,
  "stop_reason": null,
  "error": null,
  "metrics": {
    "display_only_concepts": 0,
    "unassessed_concepts": 2,
    "first_weak_question": null,
    "first_weak_answer_time_ms": null,
    "written_answers": 0,
    "ungradable_answers": 0,
    "answer_time_ms": 12000,
    "assessed_concepts": 1,
    "weak_concepts": 0
  }
}
```

### 3.4 エラーレスポンス例 (404 Not Found)

```json
{
  "detail": "指定された親ノード（parent_concept_id）が見つかりません。"
}
```

## 4. 業務処理ロジック・仕様

1. **AIによる評価目標の自動補完**:
   - ユーザーが入力した `concept_name` と `note` に基づき、LLM（`ConceptAdditionAgent`）が当該概念の適切な `description`（説明文）および `assessment_targets`（診断出題用の評価目標）を自動生成する。
2. **ノードの識別と属性設定**:
   - 一意なIDを発行し、親ノードの `child_nodes` に追加する。
   - `origin` に `"user_added"` をセットし、AI生成ノードと区別してツリー上でバッジ表示等を可能にする。
3. **出題可能化**:
   - 追加完了後、当該手動ノードも通常の概念ノードと同様に `POST /api/sessions/{session_id}/select` で選択し、診断問題を出題・回答することが可能となる。
