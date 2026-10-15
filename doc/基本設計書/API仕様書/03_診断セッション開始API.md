# 03. 診断セッション開始 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions |
| 概要 | 入力されたテーマに基づき初期知識ツリーを自動分解・構築し、診断セッションを開始する |
| 認証 | 任意（Bearer Token）。トークンなしの場合は `guest_user` として所有 |
| リクエスト形式 | application/json |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 ヘッダーパラメータ

| パラメータ名 | 型 | 必須 | デフォルト値 | 制約 | 説明 |
| --- | --- | --- | --- | --- | --- |
| `Authorization` | string | 任意 | なし | `Bearer <Token>` | 認証トークン |

### 2.2 リクエストボディ項目一覧

| フィールド名 | 型 | 必須 | デフォルト値 | 制約・許容値 | 説明 |
| --- | --- | --- | --- | --- | --- |
| `theme` | string | ○ | なし | 1〜300文字 | 診断を実施する対象テーマ（例: "微分法"） |
| `domain_context` | string | 任意 | `null` | 最大12000文字 | テーマの適用文脈、学習者の前提知識や重点事項 |
| `mode` | string | 任意 | `"gemini"` | `"gemini"`, `"demo"` | 推論エンジン。デモモードはテーマ「微分」のみ利用可能 |
| `exploration_mode` | string | 任意 | `"manual"` | `"manual"`, `"focused"`, `"comprehensive"` | 探索モード。通常は手動探索の `manual` |
| `manual_flow` | string | 任意 | `"decomposition_first"` | `"decomposition_first"`, `"combined"` | 手動探索の進行方式。通常は先行分解方式 |
| `answer_format` | string | 任意 | `"auto"` | `"auto"`, `"choice"`, `"written"` | 回答フォーマットの基本設定 |
| `allowed_question_types` | array of string | 任意 | `null` | 要素数1〜5。許容値: `multiple_choice`, `yes_no`, `short_answer`, `short_explanation`, `free_response` | 出題形式。手動分解先行フローでは `["multiple_choice"]`（4択固定） |

#### リクエストボディ例
```json
{
  "theme": "微分法と導関数",
  "domain_context": "高校数学IIレベルの微分係数と導関数の基礎",
  "mode": "gemini",
  "exploration_mode": "manual",
  "manual_flow": "decomposition_first",
  "answer_format": "auto",
  "allowed_question_types": ["multiple_choice"]
}
```

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | セッション作成成功 | 初期ツリー構築とセッション初期化が正常完了 |
| 400 Bad Request | リクエスト値不正 | 文字数制限違反、無効なモード指定、デモモードで非対応テーマ指定など |
| 503 Service Unavailable | LLM生成エラー | Gemini APIのタイムアウト・クォータ枯渇・パース失敗など |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションの一意識別子 (`sess_` prefix) | `"sess_8f3a91b2c4e5"` |
| `theme` | string | ✕ | 診断対象の全体テーマ | `"微分法と導関数"` |
| `domain_context` | string | ○ | 補足文脈情報 | `"高校数学IIレベルの微分"` |
| `mode` | string | ✕ | 推論バックエンド (`gemini` / `demo`) | `"gemini"` |
| `exploration_mode` | string | ✕ | 探索モード (`manual` / `focused` / `comprehensive`) | `"manual"` |
| `manual_flow` | string | ✕ | 手動探索進行形式 (`decomposition_first` / `combined`) | `"decomposition_first"` |
| `decomposition_max_depth` | integer | ○ | 概念分解の最大深度（先行分解モード時はnull） | `null` |
| `initial_visible_depth` | integer | ✕ | 初期表示階層深度（Geminiモード時は1） | `1` |
| `initial_generation_complete`| boolean | ✕ | 初期ツリー生成完了フラグ | `true` |
| `decomposition_statuses` | object | ✕ | ノード別分解ステータスマップ (`ready` / `generating` / `failed`) | `{"c_root": "ready"}` |
| `decomposition_depth_reason` | string | ○ | 分解階層の決定理由 | `null` |
| `focused_path` | array of string | ✕ | 現在フォーカス中の概念IDパス | `[]` |
| `answer_format` | string | ✕ | 回答形式設定 | `"auto"` |
| `allowed_question_types` | array of string | ○ | 許容出題形式配列 | `["multiple_choice"]` |
| `reassessment_concept_id` | string | ○ | 再診断対象概念ノードID | `null` |
| `active_concept_id` | string | ○ | 現在選択中のアクティブ概念ノードID | `null` |
| `paused_concept_ids` | array of string | ✕ | 中断中概念ノードIDリスト | `[]` |
| `awaiting_selection` | boolean | ✕ | 概念ノード選択待ち状態フラグ | `true` |
| `created_at` | string | ✕ | 作成日時（ISO 8601 UTC） | `"2026-10-04T12:00:00.000000+00:00"` |
| `revision` | integer | ✕ | セッション状態のリビジョン番号 | `0` |
| `knowledge_tree` | object | ✕ | 知識概念ツリーのルートノード（後述 3.2.1） | `{ ... }` |
| `concept_edges` | array of object | ✕ | 概念間依存・関連エッジ一覧（後述 3.2.2） | `[]` |
| `concept_redirects` | object | ✕ | 同一概念統合リダイレクト辞書 | `{}` |
| `canonical_refs` | object | ✕ | 他マップとの横断概念同定情報 | `{}` |
| `cross_map_matching` | boolean | ✕ | マップ間横断照合中フラグ | `false` |
| `learning_states` | object | ✕ | 各概念IDをキーとする学習状態辞書（後述 3.2.3） | `{ ... }` |
| `self_assessments` | object | ✕ | 各概念IDをキーとする自己評価辞書（後述 3.2.4） | `{ ... }` |
| `understanding_summaries` | object | ✕ | 各概念IDをキーとする理解度集計サマリー（後述 3.2.5） | `{ ... }` |
| `pending_review` | object | ○ | 学習ギャップの確認・復習保留情報 | `null` |
| `review_history` | array of object | ✕ | 確認・復習判定の履歴一覧 | `[]` |
| `next_question` | object | ○ | 次の出題問題（開始直後はnull） | `null` |
| `next_action` | object | ○ | ポリシーによる次回実行計画 | `null` |
| `evaluation` | object | ○ | 直前の回答採点結果（開始直後はnull） | `null` |
| `updated_learning_state` | object | ○ | 直前回答で更新された学習状態 | `null` |
| `evidence` | array of object | ✕ | 回答採点証拠の全履歴一覧 | `[]` |
| `question_history` | array of object | ✕ | 出題済みの全問題履歴一覧 | `[]` |
| `policy_history` | array of object | ✕ | 診断ポリシー判断履歴一覧 | `[]` |
| `questions_answered` | integer | ✕ | 回答済み問題総数 | `0` |
| `max_total_questions` | integer | ○ | セッション出題上限 | `null` |
| `complete` | boolean | ✕ | 診断セッション完了フラグ | `false` |
| `stop_reason` | string | ○ | 診断終了理由 | `null` |
| `error` | string | ○ | 直近の生成・処理エラー | `null` |
| `metrics` | object | ✕ | 進捗統計メトリクス（後述 3.2.6） | `{ ... }` |

#### 3.2.1 `knowledge_tree`（Nodeオブジェクト）の項目
| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `concept_id` | string | ✕ | 概念ノードID（例: `"c_diff_definition"`） |
| `concept_name` | string | ✕ | 概念表示名（例: `"微分係数の定義"`） |
| `description` | string | ✕ | 概念の簡潔な解説文 |
| `granularity` | string | ✕ | 粒度 (`"broad"`, `"medium"`, `"narrow"`) |
| `knowledge_type` | string | ✕ | 知識種別 (`"factual"`, `"conceptual"`, `"calculation"`, `"procedural"`, `"application"`) |
| `assessment_targets` | array of object | ✕ | 評価目標リスト (`target_id`, `description`, `knowledge_type`, `importance`) |
| `child_candidates` | array of object | ✕ | 下位分解候補リスト (`concept_name`, `description`) |
| `terminal_reason` | string | ○ | これ以上分解できない場合の終了理由 |
| `prerequisite_concept_ids` | array of string | ✕ | 前提となる概念IDリスト |
| `parent_concept_id` | string | ○ | 親概念ノードID（ルートはnull） |
| `depth` | integer | ✕ | ツリー階層深度（ルートは0、第1層は1） |
| `child_nodes` | array of object | ✕ | 直下の子概念ノード配列（同構造のNodeの再帰） |
| `terminal_confirmed` | boolean | ✕ | 末端ノード確定フラグ |
| `assessment_scope` | string | ✕ | 評価対象範囲 (`"direct"`, `"covered_by_parent"`) |
| `status` | string | ✕ | 診断進捗ステータス (`"not_assessed"`, `"assessing"`, `"learning"`, `"mastered"`, `"weak"`) |
| `origin` | string | ✕ | 作成元 (`"generated"`: AI自動生成, `"user_added"`: ユーザー手動追加) |

#### 3.2.2 `concept_edges`（KnowledgeEdgeオブジェクト）の項目
| フィールド名 | 型 | 説明 |
| --- | --- | --- |
| `source` | string | 参照元概念ノードID |
| `target` | string | 参照先概念ノードID |
| `relation` | string | 関連種別 (`"part"`, `"broader"`, `"narrower"`, `"overlap"`) |

#### 3.2.3 `learning_states`（各ノードの学習状態）の項目
| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `concept_id` | string | ✕ | 対象概念ノードID |
| `understanding_score` | float | ○ | 推定理解度スコア (0.0〜1.0) |
| `diagnostic_confidence` | float | ✕ | 診断の確信度 (0.0〜1.0) |
| `status` | string | ✕ | 理解状態ステータス (`not_assessed`, `weak`, `mastered` 等) |
| `questions_answered` | integer | ✕ | 当該ノードの回答問題数 |
| `correct_count` | integer | ✕ | 正答数 |
| `target_states` | object | ✕ | 評価目標ごとの個別状態マップ |
| `detected_misconceptions` | array of object | ✕ | 検出された誤解リスト (`description`, `confidence`) |
| `evidence_ids` | array of string | ✕ | 関連する回答証拠ID一覧 |

#### 3.2.4 `understanding_summaries`（表示用理解度集計サマリー）の項目
| フィールド名 | 型 | 説明 |
| --- | --- | --- |
| `level` | string | 判定レベル (`"high"`: 高理解度/青, `"medium"`: 中程度, `"low"`: 苦手/赤, `"unknown"`: 未診断) |
| `confidence_level` | string | 診断確信度 (`"high"`, `"medium"`, `"low"`) |
| `source` | string | 判定根拠種別 (`"diagnostic"`: 問題回答, `"self_assessment"`: 自己申告, `"default"`: 初期状態) |
| `evidence_count` | integer | 収集された証拠件数 |

#### 3.2.5 `metrics`（集計メトリクス）の項目
| フィールド名 | 型 | 説明 |
| --- | --- | --- |
| `display_only_concepts` | integer | 表示専用（親で網羅）ノード数 |
| `unassessed_concepts` | integer | 未診断のノード数 |
| `first_weak_question` | integer / null | 最初に誤答した問題番号 |
| `first_weak_answer_time_ms`| integer / null | 最初の誤答にかかった回答時間（ミリ秒） |
| `written_answers` | integer | 記述問題の回答数 |
| `ungradable_answers` | integer | 採点不能だった回答数 |
| `answer_time_ms` | integer | 合計回答時間（ミリ秒） |
| `assessed_concepts` | integer | 診断済みのノード総数 |
| `weak_concepts` | integer | 理解度が不足している（苦手）と判定されたノード数 |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "session_id": "sess_8f3a91b2c4e5",
  "theme": "微分法と導関数",
  "domain_context": "高校数学IIレベルの微分係数と導関数の基礎",
  "mode": "gemini",
  "exploration_mode": "manual",
  "manual_flow": "decomposition_first",
  "decomposition_max_depth": null,
  "initial_visible_depth": 1,
  "initial_generation_complete": true,
  "decomposition_statuses": {
    "c_root": "ready",
    "c_diff_coeff": "ready",
    "c_deriv_func": "ready"
  },
  "decomposition_depth_reason": null,
  "focused_path": [],
  "answer_format": "auto",
  "allowed_question_types": ["multiple_choice"],
  "reassessment_concept_id": null,
  "active_concept_id": null,
  "paused_concept_ids": [],
  "awaiting_selection": true,
  "created_at": "2026-10-04T12:00:00.000000+00:00",
  "revision": 0,
  "knowledge_tree": {
    "concept_id": "c_root",
    "concept_name": "微分法と導関数",
    "description": "関数の局所的な変化率と導関数の概念を扱う数学の基礎分野",
    "granularity": "broad",
    "knowledge_type": "conceptual",
    "assessment_targets": [
      {
        "target_id": "t_root_1",
        "description": "微分法の全体像を把握している",
        "knowledge_type": "conceptual",
        "importance": "core",
        "prerequisite_target_ids": []
      }
    ],
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
        "concept_name": "平均変化率と極限・微分係数",
        "description": "2点間の傾きから極限操作によって瞬間の変化率を定義する",
        "granularity": "medium",
        "knowledge_type": "conceptual",
        "assessment_targets": [
          {
            "target_id": "t_diff_coeff_1",
            "description": "微分係数の極限式を正しく立式・計算できる",
            "knowledge_type": "calculation",
            "importance": "core",
            "prerequisite_target_ids": []
          }
        ],
        "child_candidates": [
          {
            "concept_name": "平均変化率の幾何学的意味",
            "description": "グラフ上の割線の傾き"
          }
        ],
        "terminal_reason": null,
        "prerequisite_concept_ids": [],
        "parent_concept_id": "c_root",
        "depth": 1,
        "terminal_confirmed": false,
        "assessment_scope": "direct",
        "status": "not_assessed",
        "origin": "generated",
        "child_nodes": []
      },
      {
        "concept_id": "c_deriv_func",
        "concept_name": "導関数と基本公式",
        "description": "任意のxにおける微分係数を対応させる関数とその計算公式",
        "granularity": "medium",
        "knowledge_type": "procedural",
        "assessment_targets": [
          {
            "target_id": "t_deriv_func_1",
            "description": "x^nの微分公式を用いて導関数を導出できる",
            "knowledge_type": "procedural",
            "importance": "core",
            "prerequisite_target_ids": []
          }
        ],
        "child_candidates": [],
        "terminal_reason": null,
        "prerequisite_concept_ids": ["c_diff_coeff"],
        "parent_concept_id": "c_root",
        "depth": 1,
        "terminal_confirmed": false,
        "assessment_scope": "direct",
        "status": "not_assessed",
        "origin": "generated",
        "child_nodes": []
      }
    ]
  },
  "concept_edges": [
    {
      "source": "c_diff_coeff",
      "target": "c_deriv_func",
      "relation": "part"
    }
  ],
  "concept_redirects": {},
  "canonical_refs": {},
  "cross_map_matching": false,
  "learning_states": {
    "c_root": {
      "concept_id": "c_root",
      "understanding_score": null,
      "diagnostic_confidence": 0.0,
      "status": "not_assessed",
      "questions_answered": 0,
      "correct_count": 0,
      "target_states": {},
      "detected_misconceptions": [],
      "evidence_ids": []
    },
    "c_diff_coeff": {
      "concept_id": "c_diff_coeff",
      "understanding_score": null,
      "diagnostic_confidence": 0.0,
      "status": "not_assessed",
      "questions_answered": 0,
      "correct_count": 0,
      "target_states": {},
      "detected_misconceptions": [],
      "evidence_ids": []
    },
    "c_deriv_func": {
      "concept_id": "c_deriv_func",
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
    "c_root": {
      "level": "unknown",
      "confidence_level": "low",
      "source": "default",
      "evidence_count": 0
    },
    "c_diff_coeff": {
      "level": "unknown",
      "confidence_level": "low",
      "source": "default",
      "evidence_count": 0
    },
    "c_deriv_func": {
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
    "unassessed_concepts": 2,
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

### 3.4 エラーレスポンス例 (400 Bad Request)

```json
{
  "detail": "テーマは1文字以上300文字以内で指定してください。"
}
```

## 4. 業務処理ロジック・仕様

1. **初期ツリー生成**:
   - `DecompositionAgent` が LLM を呼び出し、テーマから主要な下位概念（第1層）を自動分解する。
   - Geminiモードの場合、UIには第1層のみを展開表示し、最初から第2層以降を全展開しない（誤答時に必要に応じて下位層へ深掘りする方針）。
2. **所有者紐付け**:
   - `Authorization` ヘッダーが存在する場合、セッションレコードに認証ユーザーの `user_id` を設定して永続化する。未認証の場合は `guest_user` とする。
3. **ノード重複判定と統合 (Deduplication)**:
   - 同一マップ内または他マップの既存概念との類似度判定・統合チェックがバックグラウンドで予約実行される。
4. **選択待ち状態**:
   - セッション開始直後は `active_concept_id: null`, `awaiting_selection: true`, `next_question: null` となり、UI上でユーザーが診断を開始したい概念ノードを選択する状態となる。
