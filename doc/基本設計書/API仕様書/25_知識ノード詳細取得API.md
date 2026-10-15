# 25. 知識ノード詳細取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/knowledge-nodes/{map_id}/{concept_id} |
| 概要 | 特定マップ内の指定された概念ノードに関する詳細情報、評価目標、総合理解度判定、自己評価、他マップ連携、および出題回答履歴を取得する |
| 認証 | 不要（パブリック） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ○ | `sess_` prefix | 概念ノードが所属する知識マップID |
| `concept_id` | string | ○ | ルートノード以外のID | 取得対象とする概念ノードID |

### 2.2 クエリパラメータ / リクエストボディ
なし

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | ノード詳細データが正常に取得された |
| 404 Not Found | 未存在 | 指定された `map_id` または `concept_id` が存在しない、あるいはルートノードが指定された場合 |

### 3.2 レスポンスボディ項目一覧（KnowledgeNodeDetailDTOオブジェクト）

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ✕ | 所属マップID | `"sess_8f3a91b2c4e5"` |
| `map_title` | string | ✕ | 所属マップのタイトル | `"微分法と導関数"` |
| `concept_id` | string | ✕ | 概念ノードID | `"c_diff_coeff"` |
| `concept_name` | string | ✕ | 概念ノードの表示名 | `"平均変化率と微分係数"` |
| `description` | string | ✕ | 概念の詳細解説文 | `"極限操作による瞬間変化率の定義と計算"` |
| `path` | array of string | ✕ | ルートから当該ノードまでの階層パス | `["微分法と導関数", "平均変化率と微分係数"]` |
| `assessment_targets` | array of object | ✕ | **当該ノードの評価目標一覧**（後述 3.2.1） | `[ ... ]` |
| `understanding` | object | ✕ | **現在の総合理解度判定サマリー**（後述 3.2.2） | `{ ... }` |
| `self_assessment` | object | ○ | **学習者の自己評価アンケート回答結果**（後述 3.2.3） | `{ ... }` または `null` |
| `other_maps` | array of object | ✕ | **この概念が同定・共有されている他マップ一覧**（後述 3.2.4） | `[ ... ]` |
| `history` | array of object | ✕ | **当該ノードで出題・回答された問題履歴一覧**（後述 3.2.5） | `[ ... ]` |

#### 3.2.1 `assessment_targets` の各要素（Targetオブジェクト）の項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `target_id` | string | ✕ | 評価目標ID | `"t_coeff_1"` |
| `description` | string | ✕ | 目標の具体的な内容記述 | `"極限による微分係数の計算"` |
| `knowledge_type` | string | ✕ | 知識種別 (`"calculation"`, `"conceptual"`, 等) | `"calculation"` |
| `importance` | string | ✕ | 重要度 (`"core"`, `"supporting"`) | `"core"` |
| `prerequisite_target_ids` | array of string | ✕ | 前提となる他の目標ID配列 | `[]` |

#### 3.2.2 `understanding`（理解度サマリー）の項目一覧
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `level` | string | 判定レベル (`"high"`, `"medium"`, `"low"`, `"unknown"`) | `"high"` |
| `confidence_level` | string | 確信度 (`"high"`, `"medium"`, `"low"`) | `"high"` |
| `source` | string | 判定根拠 (`"diagnostic"`, `"self_assessment"`, `"default"`) | `"diagnostic"` |
| `evidence_count` | integer | 収集された証拠件数 | `2` |

#### 3.2.3 `self_assessment`（自己評価）の項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `level` | string | ✕ | 自己申告レベル (`"high"`, `"medium"`, `"low"`, `"unsure"`) | `"high"` |
| `answered_at` | string | ✕ | 自己評価日時（ISO 8601 UTC） | `"2026-10-04T12:10:00+00:00"` |
| `origin_map_id` | string | ○ | 回答時のマップID | `null` |

#### 3.2.4 `other_maps` の各要素の項目一覧
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `map_id` | string | 同一概念が含まれる他マップのID | `"sess_999999999999"` |
| `title` | string | 他マップのタイトル | `"微分を用いた力学運動方程式"` |

#### 3.2.5 `history` の各要素（当該ノードの問題回答イベント）の項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `type` | string | ✕ | イベント種別 (`"question"`) | `"question"` |
| `at` | string | ✕ | 回答日時（ISO 8601 UTC） | `"2026-10-04T12:05:00+00:00"` |
| `map_id` | string | ✕ | マップID | `"sess_8f3a91b2c4e5"` |
| `concept_id` | string | ✕ | 概念ノードID | `"c_diff_coeff"` |
| `concept_name` | string | ✕ | 概念ノード名 | `"平均変化率と微分係数"` |
| `question` | string | ✕ | 出題問題文 | `"関数 f(x) = x^2 において..."` |
| `user_answer` | string | ✕ | 学習者の回答テキスト | `"4"` |
| `result` | string | ✕ | 判定結果 (`"correct"`, `"incorrect"`) | `"correct"` |
| `target` | string | ✕ | 評価対象となった目標文 | `"極限による微分係数の計算"` |
| `correct_answer` | string | ✕ | 正解の選択肢テキスト | `"4"` |
| `answer_explanation` | string | ✕ | 正解の解説テキスト | `"f'(2) = lim_{h->0} ..."` |
| `demonstrated_knowledge`| array of string | ✕ | 実証された知識一覧 | `["微分係数の極限計算"]` |
| `missing_knowledge` | array of string | ✕ | 不足していた知識一覧 | `[]` |
| `understanding_before` | float | ○ | 回答前の理解度スコア | `null` |
| `understanding_after` | float | ○ | 回答後の理解度スコア | `1.0` |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "map_id": "sess_8f3a91b2c4e5",
  "map_title": "微分法と導関数",
  "concept_id": "c_diff_coeff",
  "concept_name": "平均変化率と微分係数",
  "description": "極限操作による瞬間変化率の定義と計算",
  "path": [
    "微分法と導関数",
    "平均変化率と微分係数"
  ],
  "assessment_targets": [
    {
      "target_id": "t_coeff_1",
      "description": "極限による微分係数の計算",
      "knowledge_type": "calculation",
      "importance": "core",
      "prerequisite_target_ids": []
    }
  ],
  "understanding": {
    "level": "high",
    "confidence_level": "high",
    "source": "diagnostic",
    "evidence_count": 2
  },
  "self_assessment": {
    "level": "high",
    "answered_at": "2026-10-04T12:10:00+00:00",
    "origin_map_id": null
  },
  "other_maps": [
    {
      "map_id": "sess_999999999999",
      "title": "微分を用いた力学運動方程式"
    }
  ],
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
  "detail": "指定された概念ノードが見つかりません。"
}
```

## 4. 業務処理ロジック・仕様

1. **特定概念への絞り込み**:
   - マップ全体の履歴から、当該概念ノード（`concept_id`）に該当する問題回答イベントのみを抽出し、タイムスタンプ降順で整列して返却する。
2. **階層パスの動的導出**:
   - ツリーのルートから当該ノードに至るまでの概念名称パスを祖先ノードを辿って自動生成する。
3. **他マップ参照の解決**:
   - `canonical_refs` から他マップIDを抽出し、マップタイトルを解決して付与する。
