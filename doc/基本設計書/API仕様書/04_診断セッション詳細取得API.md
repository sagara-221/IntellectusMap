# 04. 診断セッション詳細取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/sessions/{session_id} |
| 概要 | 指定された診断セッションの現在の最新状態（ツリー構造、学習状態、出題中問題、履歴等）を取得する |
| 認証 | 任意（セッション所有者またはゲスト所有） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ○ | `sess_` で始まる文字列 | 取得対象の診断セッションID |

### 2.2 ヘッダーパラメータ

| パラメータ名 | 型 | 必須 | デフォルト値 | 説明 |
| --- | --- | --- | --- | --- |
| `Authorization` | string | 任意 | なし | 認証トークン (`Bearer <Token>`) |

### 2.3 クエリパラメータ / リクエストボディ
なし

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | セッションが存在し、正常にシリアライズされた場合 |
| 403 Forbidden | アクセス権限なし | 所有者以外のユーザーがアクセスした場合 |
| 404 Not Found | セッション未存在 | 指定された `session_id` のセッションが存在しない場合 |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

詳細なフィールド定義は「02. 診断セッション開始 API」と共通の `SessionDTO` 構造に準拠する。

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションID |
| `theme` | string | ✕ | 診断テーマ |
| `domain_context` | string | ○ | 補足文脈情報 |
| `mode` | string | ✕ | 推論バックエンド (`gemini` / `demo`) |
| `exploration_mode` | string | ✕ | 探索モード (`manual` / `focused` / `comprehensive`) |
| `manual_flow` | string | ✕ | 手動探索フロー種別 |
| `decomposition_max_depth` | integer | ○ | 概念分解の最大深度 |
| `initial_visible_depth` | integer | ✕ | 初期表示深度 |
| `initial_generation_complete`| boolean | ✕ | 初期生成完了フラグ |
| `decomposition_statuses` | object | ✕ | ノード別分解ステータスマップ (`ready` / `generating` / `failed`) |
| `focused_path` | array of string | ✕ | 現在フォーカス中のパス |
| `answer_format` | string | ✕ | 回答形式設定 |
| `allowed_question_types` | array of string | ○ | 許容出題形式配列 |
| `active_concept_id` | string | ○ | 現在アクティブな概念ノードID（未選択時はnull） |
| `awaiting_selection` | boolean | ✕ | 概念ノード選択待ち状態フラグ |
| `created_at` | string | ✕ | セッション作成日時 |
| `revision` | integer | ✕ | 楽観ロック用リビジョン番号 |
| `knowledge_tree` | object | ✕ | 知識ツリーのルートノードオブジェクト |
| `concept_edges` | array of object | ✕ | 概念間リレーションエッジ配列 |
| `learning_states` | object | ✕ | 概念ノードIDごとの学習状態マップ |
| `self_assessments` | object | ✕ | 概念ノードIDごとの自己評価マップ |
| `understanding_summaries` | object | ✕ | 概念ノードIDごとの理解度判定サマリーマップ (`level`: `high` / `medium` / `low` / `unknown`) |
| `next_question` | object | ○ | 現在出題中の問題オブジェクト（未出題時はnull） |
| `next_action` | object | ○ | 次の診断ポリシーアクション計画 |
| `evaluation` | object | ○ | 直前の回答採点結果 |
| `evidence` | array of object | ✕ | これまでの全回答採点履歴配列 |
| `question_history` | array of object | ✕ | これまでに出題された全問題配列 |
| `questions_answered` | integer | ✕ | 回答済み問題総数 |
| `complete` | boolean | ✕ | 診断完了フラグ |
| `metrics` | object | ✕ | 進捗・統計メトリクス集計オブジェクト |

### 3.3 成功レスポンス例 (200 OK - 出題中状態の例)

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
    "question_id": "q_1001",
    "concept_id": "c_diff_coeff",
    "assessment_target_id": "t_coeff_1",
    "difficulty": "basic",
    "question_type": "multiple_choice",
    "question_text": "関数 f(x) = x^2 において、x = 2 における微分係数 f'(2) の値として正しいものはどれか？",
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

1. **アクセス制御**:
   - `Authorization` ヘッダーに基づきセッションの所有権を確認する。
   - 所有者が異なる場合は `403 Forbidden` を返却する。
2. **正解情報の秘匿**:
   - 出題中の問題 (`next_question`) には、正解 (`expected_answer`) や解説 (`answer_explanation`)、採点用誤答対応マップ (`diagnostic_mapping`) は含まれず、フロントエンドでの不正な解答閲覧を防止する。
   - 出題済みで採点が完了した問題（`question_history`）には解説が含まれる。
3. **バックグラウンド処理の再開**:
   - サーバープロセス再起動後でも、未完了の先行生成タスク（prefetch）があれば自動でスケジュールを再開する。
