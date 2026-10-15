# 23. マップ別理解度サマリー取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/understanding-summary/{lineage_id}/maps/{map_id} |
| 概要 | 特定の系統に属する指定知識マップの各概念ノードの理解度判定結果（ロールアップサマリー）と他マップとの連携状況を取得する |
| 認証 | 不要（パブリック） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `lineage_id` | string | ○ | `lineage_` prefix | マップ系統グループID |
| `map_id` | string | ○ | `sess_` prefix | 対象の知識マップID |

### 2.2 クエリパラメータ / リクエストボディ
なし

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | マップおよび概念ノード別理解度サマリーが正常に取得された |
| 404 Not Found | 未存在 / 不一致 | 指定された `map_id` が存在しない、または指定された `lineage_id` に属していない |

### 3.2 レスポンスボディ項目一覧

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `map` | object | ✕ | **対象マップの基本情報および統計オブジェクト**（後述 3.2.1） |
| `concepts` | array of object | ✕ | **ツリー内の各概念ノードの理解度集計サマリー配列**（後述 3.2.2） |

#### 3.2.1 `map`（マップ基本情報）の項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ✕ | マップID | `"sess_8f3a91b2c4e5"` |
| `lineage_id` | string | ✕ | 系統グループID | `"lineage_1a2b3c4d"` |
| `title` | string | ✕ | マップタイトル | `"微分法と導関数"` |
| `scope` | string | ○ | スコープ補足説明 | `"高校数学IIの微分基礎"` |
| `created_at` | string | ✕ | 作成日時 | `"2026-10-04T12:00:00+00:00"` |
| `updated_at` | string | ✕ | 更新日時 | `"2026-10-04T12:30:00+00:00"` |
| `stats` | object | ✕ | 診断進捗統計情報（`explored_concepts`, `weak_concepts` 等） | `{ ... }` |
| `origin` | object | ○ | 派生元情報（派生マップ以外はnull） | `null` |

#### 3.2.2 `concepts` の各要素（ConceptSummaryItemオブジェクト）の項目一覧
ツリー内の全概念ノード（ルートノードを含む）の集計情報。

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `concept_id` | string | ✕ | 概念ノードID | `"c_diff_coeff"` |
| `concept_name` | string | ✕ | 概念ノード名 | `"平均変化率と微分係数"` |
| `depth` | integer | ✕ | ツリー階層深度（0〜） | `1` |
| `status` | string | ✕ | 診断ステータス (`"mastered"`, `"learning"`, `"weak"`, `"not_assessed"`) | `"mastered"` |
| `level` | string | ✕ | **総合理解度レベル判定**<br>・`"high"`: 高理解度（青色）<br>・`"medium"`: 中程度<br>・`"low"`: 苦手（赤色）<br>・`"unknown"`: 未診断 | `"high"` |
| `confidence_level` | string | ✕ | 判定確信度 (`"high"`, `"medium"`, `"low"`) | `"high"` |
| `source` | string | ✕ | 判定の主要根拠種別 (`"diagnostic"`, `"self_assessment"`, `"default"`) | `"diagnostic"` |
| `evidence_count` | integer | ✕ | 判定に寄与した回答証拠数 | `2` |
| `other_map_ids` | array of string | ✕ | 他のマップでも同定・共有されているマップIDの配列 | `["sess_999999999999"]` |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "map": {
    "map_id": "sess_8f3a91b2c4e5",
    "lineage_id": "lineage_1a2b3c4d",
    "title": "微分法と導関数",
    "scope": "高校数学IIの微分基礎",
    "created_at": "2026-10-04T12:00:00+00:00",
    "updated_at": "2026-10-04T12:30:00+00:00",
    "stats": {
      "explored_concepts": 2,
      "diagnosed_concepts": 1,
      "question_answers": 2,
      "survey_answers": 0,
      "weak_concepts": 0
    },
    "origin": null
  },
  "concepts": [
    {
      "concept_id": "c_root",
      "concept_name": "微分法と導関数",
      "depth": 0,
      "status": "not_assessed",
      "level": "unknown",
      "confidence_level": "low",
      "source": "default",
      "evidence_count": 0,
      "other_map_ids": []
    },
    {
      "concept_id": "c_diff_coeff",
      "concept_name": "平均変化率と微分係数",
      "depth": 1,
      "status": "mastered",
      "level": "high",
      "confidence_level": "high",
      "source": "diagnostic",
      "evidence_count": 2,
      "other_map_ids": [
        "sess_999999999999"
      ]
    },
    {
      "concept_id": "c_deriv_func",
      "concept_name": "導関数と基本公式",
      "depth": 1,
      "status": "weak",
      "level": "low",
      "confidence_level": "high",
      "source": "diagnostic",
      "evidence_count": 1,
      "other_map_ids": []
    }
  ]
}
```

### 3.4 エラーレスポンス例 (404 Not Found)

```json
{
  "detail": "指定されたマップが見つからないか、指定の系統に属していません。"
}
```

## 4. 業務処理ロジック・仕様

1. **ロールアップ集計 (Understanding Summaries)**:
   - 問題回答によるエビデンス（重み高）および自己評価アンケート（重み中）を統合し、各概念ノードの理解度レベル（`high` / `medium` / `low` / `unknown`）を判定する。
2. **マップ横断連携 (Canonical Matching)**:
   - `canonical_refs` を参照し、当該概念ノードと同一または等価と判定された他のマップID（`other_map_ids`）を配列で返却する。
