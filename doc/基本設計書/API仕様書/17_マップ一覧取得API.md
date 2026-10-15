# 17. マップ一覧取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/maps |
| 概要 | システム内に保存されているすべての知識マップ、系統（Lineage）、およびマップ間派生リレーションの一覧を取得する |
| 認証 | 不要（パブリック） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 クエリパラメータ / ヘッダー / リクエストボディ
なし

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | マップ一覧・系統・リレーションの取得に成功 |
| 500 Internal Server Error | サーバーエラー | データベースアクセス障害 |

### 3.2 レスポンスボディ項目一覧（トップレベル）

| フィールド名 | 型 | Nullable | 説明 |
| --- | --- | --- | --- |
| `maps` | array of object | ✕ | 保存されている全知識マップの概要オブジェクト配列（後述 3.2.1） |
| `lineages` | array of object | ✕ | マップ系統グループのオブジェクト配列（後述 3.2.2） |
| `relations` | array of object | ✕ | マップ間の派生・関連リンク一覧（後述 3.2.3） |

#### 3.2.1 `maps` の各要素（MapItemオブジェクト）の項目一覧
| フィールド名 | 型 | Nullable | 説明 | 具体例 |
| --- | --- | --- | --- | --- |
| `map_id` | string | ✕ | 知識マップID（セッションIDと同一） | `"sess_8f3a91b2c4e5"` |
| `lineage_id` | string | ✕ | 所属するマップ系統グループID | `"lineage_1a2b3c4d"` |
| `title` | string | ✕ | マップのタイトル・テーマ名 | `"微分法と導関数"` |
| `scope` | string | ○ | スコープ・補足説明文 | `"高校数学IIの微分基礎"` |
| `created_at` | string | ✕ | マップ作成日時（ISO 8601 UTC） | `"2026-10-04T12:00:00+00:00"` |
| `updated_at` | string | ✕ | 最終更新日時（ISO 8601 UTC） | `"2026-10-04T12:30:00+00:00"` |
| `stats` | object | ✕ | マップ内概念の診断統計情報（後述 3.2.1.1） | `{ ... }` |
| `origin` | object | ○ | 派生元マップ情報（派生作成されたマップのみ、後述 3.2.1.2） | `{ ... }` または `null` |

##### 3.2.1.1 `stats`（診断統計情報）の項目
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `explored_concepts` | integer | ツリー内の概念ノード総数（ルート除く） | `5` |
| `diagnosed_concepts` | integer | 理解度が判定された概念数（unknown以外） | `3` |
| `question_answers` | integer | 当該マップでの問題回答総数 | `7` |
| `survey_answers` | integer | 自己評価の回答総数 | `1` |
| `weak_concepts` | integer | 苦手（level: "low"）と判定された概念数 | `1` |

##### 3.2.1.2 `origin`（派生元情報）の項目
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `source_map_id` | string | 派生元の元マップID | `"sess_111111111111"` |
| `source_map_title` | string | 派生元マップのタイトル | `"数学基礎"` |
| `source_concept_id` | string | 発散候補元となった概念ノードID | `"c_functions"` |
| `source_concept_name` | string | 発散候補元となった概念名 | `"関数の極限"` |
| `category` | string | 発散カテゴリ | `"発展"` |
| `relation` | string | 元概念との関係性説明 | `"関数の極限から導出される概念"` |
| `reason` | string | 派生マップ作成理由 | `"微分計算へのステップアップのため"` |

#### 3.2.2 `lineages` の各要素（LineageItemオブジェクト）の項目一覧
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `lineage_id` | string | 系統グループの一意識別子 | `"lineage_1a2b3c4d"` |
| `root_map_id` | string | 系統の根幹となる元祖マップID | `"sess_8f3a91b2c4e5"` |
| `title` | string | 系統グループの代表タイトル | `"微分法と導関数"` |
| `map_ids` | array of string | この系統に属する派生マップを含む全マップIDリスト | `["sess_8f3a91b2c4e5", "sess_999999999999"]` |

#### 3.2.3 `relations` の各要素（RelationItemオブジェクト）の項目一覧
| フィールド名 | 型 | 説明 | 具体例 |
| --- | --- | --- | --- |
| `source_map_id` | string | 派生元マップID | `"sess_8f3a91b2c4e5"` |
| `target_map_id` | string | 派生先マップID | `"sess_999999999999"` |
| `source_concept_id` | string | 派生元の概念ノードID | `"c_diff_coeff"` |
| `category` | string | 発散カテゴリ名 | `"応用展開"` |
| `relation` | string | 関連性の簡潔な説明 | `"物理学における速度・加速度との対応"` |
| `reason` | string | 発散・派生された学習理由 | `"微分の応用例として力学の理解を深める"` |

### 3.3 成功レスポンス例 (200 OK)

```json
{
  "maps": [
    {
      "map_id": "sess_8f3a91b2c4e5",
      "lineage_id": "lineage_1a2b3c4d",
      "title": "微分法と導関数",
      "scope": "高校数学IIの微分基礎",
      "created_at": "2026-10-04T12:00:00+00:00",
      "updated_at": "2026-10-04T12:30:00+00:00",
      "stats": {
        "explored_concepts": 4,
        "diagnosed_concepts": 2,
        "question_answers": 3,
        "survey_answers": 0,
        "weak_concepts": 1
      },
      "origin": null
    },
    {
      "map_id": "sess_999999999999",
      "lineage_id": "lineage_1a2b3c4d",
      "title": "微分を用いた物理運動方程式",
      "scope": "速度・加速度への微分応用",
      "created_at": "2026-10-04T13:00:00+00:00",
      "updated_at": "2026-10-04T13:15:00+00:00",
      "stats": {
        "explored_concepts": 3,
        "diagnosed_concepts": 1,
        "question_answers": 2,
        "survey_answers": 1,
        "weak_concepts": 0
      },
      "origin": {
        "source_map_id": "sess_8f3a91b2c4e5",
        "source_map_title": "微分法と導関数",
        "source_concept_id": "c_diff_coeff",
        "source_concept_name": "平均変化率と微分係数",
        "category": "応用展開",
        "relation": "物理学における速度・加速度との対応",
        "reason": "微分の応用例として力学の理解を深める"
      }
    }
  ],
  "lineages": [
    {
      "lineage_id": "lineage_1a2b3c4d",
      "root_map_id": "sess_8f3a91b2c4e5",
      "title": "微分法と導関数",
      "map_ids": [
        "sess_8f3a91b2c4e5",
        "sess_999999999999"
      ]
    }
  ],
  "relations": [
    {
      "source_map_id": "sess_8f3a91b2c4e5",
      "target_map_id": "sess_999999999999",
      "source_concept_id": "c_diff_coeff",
      "category": "応用展開",
      "relation": "物理学における速度・加速度との対応",
      "reason": "微分の応用例として力学の理解を深める"
    }
  ]
}
```

## 4. 業務処理ロジック・仕様

1. **装飾処理 (Decoration)**:
   - 各マップについて、関連する学習履歴やエビデンスから最新の診断進捗統計（`stats`）を動的に集計して付与する。
   - 派生マップの場合、元マップから `source_map_title` と `source_concept_name` を解決して `origin` オブジェクトを補完する。
2. **マップ系統のグルーピング**:
   - 発散候補から新マップが作成されるたびに同一系統（`lineage_id`）として追跡管理され、マップ同士の親子・派生ツリー関係を可視化できるように返却する。
