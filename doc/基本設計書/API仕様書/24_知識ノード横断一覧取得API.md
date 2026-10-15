# 24. 知識ノード横断一覧取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/knowledge-nodes |
| 概要 | 全知識マップを横断して概念ノードを検索・フィルタリング・ページネーションし、統合された理解度一覧を取得する |
| 認証 | 不要（パブリック） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 クエリパラメータ項目一覧

| パラメータ名 | 型 | 必須 | デフォルト値 | 制約・許容値 | 説明 |
| --- | --- | --- | --- | --- | --- |
| `q` | string | 任意 | `""` | 最大200文字 | 概念名・説明文・マップタイトルの部分一致検索キーワード |
| `map_id` | string | 任意 | `null` | 既存のマップID | 特定マップ内のノードに絞り込む場合のマップID |
| `level` | string | 任意 | `"all"` | `"all"`, `"high"`, `"medium"`, `"low"`, `"unknown"`, `"mixed"` | 理解度レベルによる絞り込み |
| `sort` | string | 任意 | `"priority"` | `"priority"`, `"understood"`, `"name"`, `"recent"`, `"questions"` | ソート順序（優先度順/高理解度順/名称順/最新順/回答数順） |
| `page` | integer | 任意 | `1` | 1以上 | 取得するページ番号 |
| `page_size` | integer | 任意 | `50` | 1〜100 | 1ページあたりの取得件数 |

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | 検索・フィルタリング結果が正常に返却された |
| 404 Not Found | 未存在 | 絞り込み指定した `map_id` が存在しない場合 |

### 3.2 レスポンスボディ項目一覧（トップレベル）

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `items` | array of object | ✕ | **横断概念ノードの行データ配列**（後述 3.2.1） | `[ ... ]` |
| `total` | integer | ✕ | 検索・絞り込み条件に合致した総ノード件数 | `42` |
| `page` | integer | ✕ | 現在のページ番号 | `1` |
| `page_size` | integer | ✕ | 1ページあたりの件数 | `50` |
| `counts` | object | ✕ | **理解度レベルごとの全体件数サマリー辞書**（後述 3.2.2） | `{ ... }` |
| `maps` | array of object | ✕ | 絞り込み用セレクタに利用可能なマップ一覧 (`map_id`, `title`) | `[ ... ]` |

#### 3.2.1 `items` の各要素（KnowledgeNodeRowオブジェクト）の項目一覧
複数マップで同一と認定された概念ノードは1つの代表行としてグルーピングされる。

| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `canonical_id` | string | ✕ | 横断統合ID（非統合ノードは `map_id:concept_id`） | `"canonical_diff_coeff"` |
| `map_id` | string | ✕ | 代表ノードの所属マップID | `"sess_8f3a91b2c4e5"` |
| `concept_id` | string | ✕ | 代表ノードの概念ノードID | `"c_diff_coeff"` |
| `concept_name` | string | ✕ | 代表概念ノード名 | `"平均変化率と微分係数"` |
| `description` | string | ✕ | 代表概念の説明文 | `"極限操作による瞬間変化率"` |
| `path` | array of string | ✕ | ルートから代表ノードまでの階層パス | `["微分法と導関数", "平均変化率と微分係数"]` |
| `aliases` | array of string | ✕ | 他マップで用いられている別名一覧 | `["微分係数の定義"]` |
| `map_count` | integer | ✕ | この概念が存在するマップの総数 | `2` |
| `assessed_map_count`| integer | ✕ | 診断が実施されたマップの数 | `1` |
| `level` | string | ✕ | **総合理解度レベル** (`"high"`, `"medium"`, `"low"`, `"unknown"`, `"mixed"`) | `"high"` |
| `confidence_level` | string | ✕ | 総合確信度 (`"high"`, `"medium"`, `"low"`, `"mixed"`) | `"high"` |
| `source` | string | ✕ | 判定の根拠 (`"diagnostic"`, `"self_assessment"`, `"multiple_maps"`, 等) | `"diagnostic"` |
| `question_answers` | integer | ✕ | この概念に対して回答された問題総数 | `2` |
| `last_assessed_at` | string | ○ | 最後に回答または自己評価された日時（ISO 8601 UTC） | `"2026-10-04T12:05:00+00:00"` |
| `map_results` | array of object | ✕ | マップごとの個別出現・診断結果リスト（後述 3.2.1.1） | `[ ... ]` |

##### 3.2.1.1 `map_results` の各要素の項目
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ✕ | 出現元のマップID | `"sess_8f3a91b2c4e5"` |
| `map_title` | string | ✕ | 出現元のマップタイトル | `"微分法と導関数"` |
| `lineage_id` | string | ✕ | 所属系統ID | `"lineage_1a2b3c4d"` |
| `concept_id` | string | ✕ | 当該マップでの概念ID | `"c_diff_coeff"` |
| `concept_name` | string | ✕ | 当該マップでの概念名 | `"平均変化率と微分係数"` |
| `level` | string | ✕ | 当該マップでの理解度レベル | `"high"` |
| `confidence_level` | string | ✕ | 当該マップでの確信度 | `"high"` |
| `direct_question_answers` | integer | ✕ | 直接回答数 | `2` |
| `shared_question_answers` | integer | ✕ | 他マップから共有された回答数 | `0` |
| `self_assessment` | string | ○ | 当該マップでの自己評価レベル | `null` |

#### 3.2.2 `counts`（理解度レベル別件数辞書）の項目
| フィールド名 | 型 | 説明 |
| --- | --- | --- |
| `all` | integer | 条件合致ノードの総件数 |
| `high` | integer | 理解度高い（青色）ノード件数 |
| `medium` | integer | 理解度中程度ノード件数 |
| `low` | integer | 苦手（赤色）ノード件数 |
| `unknown` | integer | 未診断ノード件数 |
| `mixed` | integer | マップ間で判定が分かれているノード件数 |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "items": [
    {
      "canonical_id": "canonical_diff_coeff",
      "map_id": "sess_8f3a91b2c4e5",
      "concept_id": "c_diff_coeff",
      "concept_name": "平均変化率と微分係数",
      "description": "極限操作による瞬間変化率の定義と計算",
      "path": [
        "微分法と導関数",
        "平均変化率と微分係数"
      ],
      "aliases": [
        "微分係数の基礎"
      ],
      "map_count": 2,
      "assessed_map_count": 1,
      "level": "high",
      "confidence_level": "high",
      "source": "diagnostic",
      "question_answers": 2,
      "last_assessed_at": "2026-10-04T12:05:00+00:00",
      "map_results": [
        {
          "map_id": "sess_8f3a91b2c4e5",
          "map_title": "微分法と導関数",
          "lineage_id": "lineage_1a2b3c4d",
          "concept_id": "c_diff_coeff",
          "concept_name": "平均変化率と微分係数",
          "description": "極限操作による瞬間変化率",
          "path": ["微分法と導関数", "平均変化率と微分係数"],
          "depth": 1,
          "level": "high",
          "confidence_level": "high",
          "source": "diagnostic",
          "direct_question_answers": 2,
          "shared_question_answers": 0,
          "self_assessment": null,
          "last_assessed_at": "2026-10-04T12:05:00+00:00",
          "assessment_scope": "direct"
        }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "page_size": 50,
  "counts": {
    "all": 1,
    "high": 1,
    "medium": 0,
    "low": 0,
    "unknown": 0,
    "mixed": 0
  },
  "maps": [
    {
      "map_id": "sess_8f3a91b2c4e5",
      "title": "微分法と導関数"
    }
  ]
}
```

## 4. 業務処理ロジック・仕様

1. **ソートロジック**:
   - `sort=priority`: 苦手（`low`）→ 判定揺れ（`mixed`）→ 未診断（`unknown`）→ 中（`medium`）→ 高（`high`）の順で、弱点克服の優先度が高い順にソート。
   - `sort=understood`: 高理解度（`high`）を先頭にソート。
   - `sort=recent`: 最終診断日時（`last_assessed_at`）の降順。
   - `sort=questions`: 回答問題数（`question_answers`）の降順。
2. **マップ横断同一性の集約**:
   - `canonical_id` により異なるマップで学んだ同等の知識項目が1つに束ねられ、学習者が全体としてどの分野をどれだけ理解しているかを一覧で把握できる。
