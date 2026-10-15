# 07. 問題回答送信 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/answers |
| 概要 | 出題された問題に対する学習者の回答を送信し、自動採点・理解状態の更新・次アクションの判定を行う |
| 認証 | 任意（セッション所有者またはゲスト所有） |
| リクエスト形式 | application/json |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ○ | `sess_` prefix | 診断セッションID |

### 2.2 リクエストボディ項目一覧

| フィールド名 | 型 | 必須 | デフォルト値 | 制約・許容値 | 説明 |
| --- | --- | --- | --- | --- | --- |
| `question_id` | string | ○ | なし | 1文字以上 | 回答対象の問題ID（例: `"q_2001"`） |
| `answer` | string | ○ | なし | 1〜5000文字 | 選択肢ID（4択の場合 `"c2"` など）または自由記述回答文 |
| `user_confidence` | string | 任意 | `null` | `"high"`, `"medium"`, `"low"`, `null` | 回答時の自己確信度 |
| `answer_time_ms` | integer | 任意 | `null` | 0〜86,400,000 (24時間) | 回答所要時間（ミリ秒） |
| `immediate_feedback` | boolean | 任意 | `false` | `true`, `false` | 即時フィードバックフラグ（通常false） |

#### リクエストボディ例
```json
{
  "question_id": "q_2001",
  "answer": "c2",
  "user_confidence": "high",
  "answer_time_ms": 12500,
  "immediate_feedback": false
}
```

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 採点・更新成功 | 回答が正常に処理され、採点結果および最新セッション状態が返却された |
| 400 Bad Request | リクエスト不正 | 必須項目欠落、出題中以外の問題に対する回答、不正な回答形式など |
| 404 Not Found | 未存在 | セッションまたは問題IDが見つからない |
| 503 Service Unavailable | 採点エラー | 記述問題におけるLLM採点タイムアウトやエラー |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

本APIのレスポンス（`SessionDTO`）には、採点結果 (`evaluation`)、更新された学習状態 (`updated_learning_state`)、解説が開示された出題履歴 (`question_history`) などが含まれる。

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションID |
| `evaluation` | object | ○ | **今回送信された回答に対する採点結果**（後述 3.2.1） |
| `updated_learning_state` | object | ○ | **回答後に再計算された当該ノードの学習状態**（後述 3.2.2） |
| `understanding_summaries`| object | ✕ | **全ノードの最新理解度サマリー**（後述 3.2.3） |
| `knowledge_tree` | object | ✕ | 誤答時に下位概念が自動分解・追加された最新ツリー |
| `question_history` | array of object | ✕ | **回答済み問題の一覧（正解・解説を含む）**（後述 3.2.4） |
| `evidence` | array of object | ✕ | 収集された回答証拠の全一覧 |
| `next_question` | object | ○ | 続いて出題される次の問題（存在する場合） |
| `active_concept_id` | string | ○ | 現在アクティブな概念ノードID |
| `awaiting_selection` | boolean | ✕ | 次のノード選択が必要な状態か否か |
| `questions_answered` | integer | ✕ | 回答済み問題総数（+1加算） |
| `metrics` | object | ✕ | 回答時間や苦手ノード数などの最新統計情報 |

#### 3.2.1 `evaluation`（採点評価結果）の項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `correctness` | string | ✕ | 判定結果 (`"correct"`, `"partially_correct"`, `"incorrect"`, `"ungradable"`) | `"correct"` |
| `score` | float | ✕ | 獲得スコア (0.0〜1.0) | `1.0` |
| `evaluation_confidence` | float | ✕ | 採点確信度 (0.0〜1.0) | `1.0` |
| `demonstrated_knowledge` | array of string | ✕ | 回答から実証された習得済み知識リスト | `["微分係数の極限計算"]` |
| `missing_knowledge` | array of string | ✕ | 不足または欠落している知識リスト | `[]` |
| `misconception_candidates`| array of object | ✕ | 検出された誤解リスト (`description`, `confidence`) | `[]` |
| `needs_additional_assessment`| boolean | ✕ | 追加の確認診断が必要か否か | `false` |

#### 3.2.2 `updated_learning_state` の項目一覧
| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `concept_id` | string | ✕ | 概念ノードID |
| `understanding_score` | float | ○ | 更新後の理解度スコア (0.0〜1.0) |
| `diagnostic_confidence` | float | ✕ | 診断確信度 (0.0〜1.0) |
| `status` | string | ✕ | 理解状態ステータス (`"mastered"`, `"learning"`, `"weak"`, `"assessing"`) |
| `questions_answered` | integer | ✕ | 当該ノードでの回答完了問題数 |
| `correct_count` | integer | ✕ | 正答数 |
| `target_states` | object | ✕ | 個別評価目標ごとのスコア・ステータス |
| `detected_misconceptions` | array of object | ✕ | 蓄積された誤解リスト |
| `evidence_ids` | array of string | ✕ | 当該ノードに紐づく証拠IDリスト |

#### 3.2.3 `understanding_summaries` の項目一覧
| フィールド名 | 型 | 説明 |
| --- | --- | --- |
| `level` | string | 理解度レベル (`"high"`: 高理解度/青, `"medium"`: 中程度, `"low"`: 苦手/赤, `"unknown"`: 未診断) |
| `confidence_level` | string | 確信度 (`"high"`, `"medium"`, `"low"`) |
| `source` | string | 判定根拠 (`"diagnostic"`, `"self_assessment"`, `"default"`) |
| `evidence_count` | integer | 回答証拠件数 |

#### 3.2.4 `question_history` の各問題項目一覧（解説開示）
| フィールド名 | 型 | 説明 |
| --- | --- | --- |
| `question_id` | string | 問題ID |
| `concept_id` | string | 対象概念ノードID |
| `question_text` | string | 問題文 |
| `choices` | array of object | 選択肢一覧 |
| `expected_answer` | array of string | **正解の選択肢IDリスト**（例: `["c2"]`） |
| `answer_explanation` | string | **正解の詳しい解説テキスト** |
| `grading_type` | string | 採点方式 (`"choice_match"`, `"exact_match"`, 等) |

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
      "target_states": {
        "t_coeff_1": {
          "target_id": "t_coeff_1",
          "understanding_score": 1.0,
          "diagnostic_confidence": 0.8,
          "questions_answered": 1,
          "correct_count": 1,
          "status": "mastered",
          "evidence_ids": ["ev_1a2b3c4d5e6f"]
        }
      },
      "detected_misconceptions": [],
      "evidence_ids": ["ev_1a2b3c4d5e6f"]
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
  "next_action": {
    "session_question_count": 1,
    "action": "move_to_next_concept",
    "concept_id": "c_diff_coeff",
    "question_requests": [],
    "expand_target_id": null,
    "reason_code": "CONCEPT_MASTERED"
  },
  "evaluation": {
    "correctness": "correct",
    "score": 1.0,
    "evaluation_confidence": 1.0,
    "demonstrated_knowledge": ["極限計算による微分係数の導出"],
    "missing_knowledge": [],
    "misconception_candidates": [],
    "needs_additional_assessment": false
  },
  "updated_learning_state": {
    "concept_id": "c_diff_coeff",
    "understanding_score": 1.0,
    "diagnostic_confidence": 0.8,
    "status": "mastered",
    "questions_answered": 1,
    "correct_count": 1,
    "target_states": {},
    "detected_misconceptions": [],
    "evidence_ids": ["ev_1a2b3c4d5e6f"]
  },
  "evidence": [
    {
      "evidence_id": "ev_1a2b3c4d5e6f",
      "question_id": "q_2001",
      "concept_id": "c_diff_coeff",
      "assessment_target_id": "t_coeff_1",
      "user_answer": "c2",
      "user_confidence": "high",
      "answer_time_ms": 12500,
      "grading_method": "choice_match",
      "correctness": "correct",
      "score": 1.0,
      "evaluation_confidence": 1.0,
      "demonstrated_knowledge": ["極限計算による微分係数の導出"],
      "missing_knowledge": [],
      "misconception_candidates": [],
      "needs_additional_assessment": false,
      "understanding_before": null,
      "understanding_after": 1.0,
      "answered_at": "2026-10-04T12:05:00.000000+00:00",
      "origin_map_id": null
    }
  ],
  "question_history": [
    {
      "question_id": "q_2001",
      "concept_id": "c_diff_coeff",
      "assessment_target_id": "t_coeff_1",
      "difficulty": "basic",
      "question_type": "multiple_choice",
      "question_text": "関数 f(x) = x^2 において、x = 2 における微分係数 f'(2) の値として正しいものを選択せよ。",
      "choices": [
        { "choice_id": "c1", "text": "2" },
        { "choice_id": "c2", "text": "4" },
        { "choice_id": "c3", "text": "x" },
        { "choice_id": "c4", "text": "8" }
      ],
      "expected_answer": ["c2"],
      "answer_explanation": "f'(2) = lim_{h->0} ((2+h)^2 - 4)/h = lim_{h->0} (4h + h^2)/h = 4 となります。",
      "grading_type": "choice_match",
      "origin_map_id": null
    }
  ],
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
    "answer_time_ms": 12500,
    "assessed_concepts": 1,
    "weak_concepts": 0
  }
}
```

### 3.4 エラーレスポンス例 (400 Bad Request)

```json
{
  "detail": "指定された問題IDは現在の出題中問題と一致しません。"
}
```

## 4. 業務処理ロジック・仕様

1. **確定的な採点判定**:
   - 4択問題・正誤問題の場合、正解ID（`expected_answer`）との完全一致判定を行い、`score: 1.0`（正答）または `0.0`（誤答）を即時に確定する。
   - 自由記述問題の場合は `EvaluationAgent` が呼び出され、セマンティック評価が実行される。
2. **証拠保存と学習状態更新**:
   - 回答結果を `Evidence` レコードとして保存する。
   - ベイズ更新アルゴリズム等に基づき、該当ノードおよび個別評価目標の `understanding_score`（理解度スコア）と `diagnostic_confidence`（確信度）を再計算する。
3. **理解度サマリーの更新**:
   - 理解度スコアが 0.8 以上の場合は `"high"`（青色）、0.4 未満の場合は `"low"`（赤色）に `understanding_summaries[concept_id].level` が更新される。
4. **適応的深掘り（誤答時の下位概念自動分解）**:
   - 回答が誤答 (`incorrect`) で、かつ当該ノードがまだ下位に分解されていない場合、これまでの全層での誤答内容（`mistake_details`）を踏まえて `DecompositionAgent` が自動で下位概念ノード群を生成し、`knowledge_tree` に追加展開する。
   - 正答（`correct`）した場合は不要な深掘りは行わず、同階層の次の重要概念の診断へ移行する。
5. **正解・解説の公開**:
   - 回答完了に伴い、`question_history` に当該問題の正解および解説が含まれるようになり、UI側で学習者に即座に解説を提示できる。
