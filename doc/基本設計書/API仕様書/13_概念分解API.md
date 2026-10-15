# 13. 概念分解 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/decompose |
| 概要 | 知識ツリー上の指定された概念ノードをさらに下位の詳細な概念（子ノード群）へ分解・展開する |
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
| `concept_id` | string | ○ | 1文字以上 | 分解対象の概念ノードID（ルートノード以外） | `"c_diff_coeff"` |

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
| 200 OK | 分解成功 | 子概念ノードが正常にツリーへ追加され、更新後のセッション状態が返却された |
| 400 Bad Request | リクエスト不正 | ルートノードを指定した場合、これ以上分解できない末端ノードを指定した場合など |
| 404 Not Found | 未存在 | セッションまたは対象概念ノードが存在しない |
| 503 Service Unavailable | 生成エラー | LLMによる概念分解処理のタイムアウトやエラー |

### 3.2 レスポンスボディ項目一覧（セッション詳細オブジェクト）

本APIは更新後のセッション全体オブジェクト（`SessionDTO`）を返却する。

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `session_id` | string | ✕ | 診断セッションID |
| `knowledge_tree` | object | ✕ | **対象ノード直下に新しく生成された `child_nodes` が格納されたツリー**（後述 3.2.1） |
| `decomposition_statuses` | object | ✕ | 各ノードの分解ステータス（該当ノードが `"ready"` に更新） |
| `learning_states` | object | ✕ | 新規追加された子ノードの初期学習状態（`status: "not_assessed"`）が追加 |
| `understanding_summaries`| object | ✕ | 新規追加された子ノードの初期理解度サマリー（`level: "unknown"`）が追加 |
| `revision` | integer | ✕ | リビジョン番号（更新に伴いインクリメント） |

#### 3.2.1 分解により追加された子ノード（`child_nodes` 内の各Node）の項目
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `concept_id` | string | ✕ | 子概念ノードの一意識別子 | `"c_limit_definition"` |
| `concept_name` | string | ✕ | 子概念名 | `"極限の厳密な定義"` |
| `description` | string | ✕ | 概念の詳細説明 | `"関数の極限と収束の数学的意味"` |
| `depth` | integer | ✕ | 親ノードのdepth + 1 | `2` |
| `parent_concept_id` | string | ✕ | 親概念ノードID | `"c_diff_coeff"` |
| `granularity` | string | ✕ | 粒度 (`"narrow"` または `"medium"`) | `"narrow"` |
| `knowledge_type` | string | ✕ | 知識種別 | `"conceptual"` |
| `assessment_targets` | array of object | ✕ | 評価目標リスト | `[ ... ]` |
| `status` | string | ✕ | 初期状態は `"not_assessed"` | `"not_assessed"` |
| `origin` | string | ✕ | 生成元種別 (`"generated"`) | `"generated"` |
| `child_nodes` | array of object | ✕ | 空配列 `[]` | `[]` |

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
  "revision": 4,
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
        "status": "weak",
        "origin": "generated",
        "child_nodes": [
          {
            "concept_id": "c_avg_rate",
            "concept_name": "平均変化率と割線の傾き",
            "description": "2点間を結ぶ直線の傾きとしての変化の割合",
            "granularity": "narrow",
            "knowledge_type": "conceptual",
            "assessment_targets": [
              {
                "target_id": "t_avg_1",
                "description": "Δy/Δxの計算ができる",
                "knowledge_type": "calculation",
                "importance": "core",
                "prerequisite_target_ids": []
              }
            ],
            "child_candidates": [],
            "terminal_reason": "これ以上の細分化は不要な基本計算要素",
            "prerequisite_concept_ids": [],
            "parent_concept_id": "c_diff_coeff",
            "depth": 2,
            "terminal_confirmed": true,
            "assessment_scope": "direct",
            "status": "not_assessed",
            "origin": "generated",
            "child_nodes": []
          },
          {
            "concept_id": "c_limit_zero",
            "concept_name": "hを0に近づける極限操作",
            "description": "不定形 0/0 を解消して極限値を求める手法",
            "granularity": "narrow",
            "knowledge_type": "procedural",
            "assessment_targets": [
              {
                "target_id": "t_lim_1",
                "description": "約分による不定形の解消ができる",
                "knowledge_type": "procedural",
                "importance": "core",
                "prerequisite_target_ids": []
              }
            ],
            "child_candidates": [],
            "terminal_reason": "基本極限計算の最小構成要素",
            "prerequisite_concept_ids": ["c_avg_rate"],
            "parent_concept_id": "c_diff_coeff",
            "depth": 2,
            "terminal_confirmed": true,
            "assessment_scope": "direct",
            "status": "not_assessed",
            "origin": "generated",
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
    "c_diff_coeff": {
      "concept_id": "c_diff_coeff",
      "understanding_score": 0.2,
      "diagnostic_confidence": 0.8,
      "status": "weak",
      "questions_answered": 1,
      "correct_count": 0,
      "target_states": {},
      "detected_misconceptions": [],
      "evidence_ids": ["ev_1"]
    },
    "c_avg_rate": {
      "concept_id": "c_avg_rate",
      "understanding_score": null,
      "diagnostic_confidence": 0.0,
      "status": "not_assessed",
      "questions_answered": 0,
      "correct_count": 0,
      "target_states": {},
      "detected_misconceptions": [],
      "evidence_ids": []
    },
    "c_limit_zero": {
      "concept_id": "c_limit_zero",
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
    "c_diff_coeff": {
      "level": "low",
      "confidence_level": "high",
      "source": "diagnostic",
      "evidence_count": 1
    },
    "c_avg_rate": {
      "level": "unknown",
      "confidence_level": "low",
      "source": "default",
      "evidence_count": 0
    },
    "c_limit_zero": {
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
    "first_weak_question": 1,
    "first_weak_answer_time_ms": 20000,
    "written_answers": 0,
    "ungradable_answers": 0,
    "answer_time_ms": 20000,
    "assessed_concepts": 1,
    "weak_concepts": 1
  }
}
```

### 3.4 エラーレスポンス例 (400 Bad Request)

```json
{
  "detail": "この項目はこれ以上分解できません。"
}
```

## 4. 業務処理ロジック・仕様

1. **先行生成キャッシュ (Prefetch) の利用**:
   - バックグラウンドで既に該当ノードの分解結果が生成キャッシュされていた場合は、即時に適用して高速レスポンスを返す。
   - キャッシュがない場合は `DecompositionAgent` が実行され、子概念を生成する。
2. **既存ノードとの重複排除**:
   - 既存ツリーに既に存在する同名概念やリダイレクト概念との重複排除が行われ、必要に応じて統合処理が施される。
3. **学習状態・サマリーの初期化**:
   - 新規作成された各子ノードに対して、初期学習状態 (`status: "not_assessed"`) およびサマリー (`level: "unknown"`) が自動登録される。
