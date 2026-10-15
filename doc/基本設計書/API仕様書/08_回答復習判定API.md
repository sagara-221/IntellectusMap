# 08. 回答復習判定 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/reviews |
| 概要 | 診断中に提示された学習ギャップ（つまずきポイント）の確認サマリーに対して、学習者の判断（理解できた/探索を継続する）を送信する |
| 認証 | 任意（セッション所有者またはゲスト所有） |
| リクエスト形式 | application/json |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ○ | `sess_` prefix | 診断セッションID |

### 2.2 リクエストボディ項目一覧

| フィールド名 | 型 | 必須 | 制約・許容値 | 説明 | 具体例 |
| --- | --- | --- | --- | --- | --- |
| `review_id` | string | ○ | 1文字以上 | 判定対象の確認復習レビューID | `"review_3c4d5e6f7a8b"` |
| `decision` | string | ○ | `"understood_gap"`, `"continue_exploring"` | 学習者の選択意思。<br>・`"understood_gap"`: つまずきの原因を理解した<br>・`"continue_exploring"`: さらに詳細に探索・深掘りを進める | `"understood_gap"` |

#### リクエストボディ例
```json
{
  "review_id": "review_3c4d5e6f7a8b",
  "decision": "understood_gap"
}
```

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | レビュー判定成功 | レビューが確定し、次アクションが決定された最新セッション状態が返却された |
| 400 Bad Request | リクエスト不正 | 必須パラメータの欠落、存在しないレビューID、無効な意思決定値など |
| 404 Not Found | 未存在 | セッションが存在しない |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

本APIは更新後のセッション全体オブジェクト（`SessionDTO`）を返却する。

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションID |
| `pending_review` | object | ○ | **判定完了により `null` となる** |
| `review_history` | array of object | ✕ | **今回送信された判定結果が追加された履歴配列**（後述 3.2.1） |
| `next_action` | object | ○ | 意思決定に基づき決定された次回の診断アクション計画 |
| `next_question` | object | ○ | 探索継続時に新たに生成・出題される次の問題（存在する場合） |
| `active_concept_id` | string | ○ | 現在アクティブな概念ノードID |
| `awaiting_selection` | boolean | ✕ | ノード選択待ち状態か否か |
| `complete` | boolean | ✕ | セッション全体の診断完了フラグ |

#### 3.2.1 `review_history` の各要素（ReviewDecisionオブジェクト）の項目一覧
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `review` | object | 対象となった確認復習レビュー情報 | `{ "review_id": "review_3c4d5e6f7a8b", ... }` |
| `decision` | string | 学習者が選択した意思決定 (`"understood_gap"` / `"continue_exploring"`) | `"understood_gap"` |
| `questions_answered` | integer | このレビュー時点での回答済み問題数 | `3` |

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
  "revision": 3,
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
    "child_nodes": []
  },
  "concept_edges": [],
  "concept_redirects": {},
  "canonical_refs": {},
  "cross_map_matching": false,
  "learning_states": {},
  "self_assessments": {},
  "understanding_summaries": {},
  "pending_review": null,
  "review_history": [
    {
      "review": {
        "review_id": "review_3c4d5e6f7a8b",
        "concept_id": "c_diff_coeff",
        "concept_name": "平均変化率と微分係数",
        "layer": 1,
        "reason_code": "GAP_IDENTIFIED",
        "summary": "極限計算における分母が0になる不定形の解消法に理解のギャップが確認されました。",
        "demonstrated": ["平均変化率の立式"],
        "weak_candidates": ["極限の因数分解による約分"],
        "unresolved": [],
        "evidence_ids": ["ev_1a2b3c4d5e6f"],
        "diagnostic_confidence": 0.85,
        "unassessed_concepts": 2,
        "can_expand": true,
        "next_step": "下位概念の個別診断へ移行"
      },
      "decision": "understood_gap",
      "questions_answered": 3
    }
  ],
  "next_question": null,
  "next_action": {
    "session_question_count": 3,
    "action": "move_to_next_concept",
    "concept_id": null,
    "question_requests": [],
    "expand_target_id": null,
    "reason_code": "REVIEW_RESOLVED"
  },
  "evaluation": null,
  "updated_learning_state": null,
  "evidence": [],
  "question_history": [],
  "policy_history": [],
  "questions_answered": 3,
  "max_total_questions": null,
  "complete": false,
  "stop_reason": null,
  "error": null,
  "metrics": {
    "display_only_concepts": 0,
    "unassessed_concepts": 2,
    "first_weak_question": 2,
    "first_weak_answer_time_ms": 15000,
    "written_answers": 0,
    "ungradable_answers": 0,
    "answer_time_ms": 32000,
    "assessed_concepts": 1,
    "weak_concepts": 1
  }
}
```

### 3.4 エラーレスポンス例 (400 Bad Request)

```json
{
  "detail": "該当するレビュー保留情報（pending_review）が存在しません。"
}
```

## 4. 業務処理ロジック・仕様

1. **レビュー保留状態の解決**:
   - `session.pending_review` の内容とリクエストの `review_id` が一致することを確認する。
   - `decision` と現在の回答数を記録した `ReviewDecision` を作成し、`session.review_history` に追加する。
   - `session.pending_review` を `null` にクリアする。
2. **分岐制御**:
   - `decision == "understood_gap"` の場合: つまずき原因が学習者に伝達されたものとして、未診断の他概念への探索へ促す（`awaiting_selection = true`）。
   - `decision == "continue_exploring"` の場合: 当該概念の下位概念または補強問題の自動生成・出題へと進む。
