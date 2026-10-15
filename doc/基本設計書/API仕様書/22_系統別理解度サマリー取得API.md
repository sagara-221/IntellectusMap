# 22. 系統別理解度サマリー取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/understanding-summary/{lineage_id} |
| 概要 | 特定の系統（Lineage）に属するすべての派生マップを対象として、概念ノードの重複を排除した横断理解度集計メトリクスを取得する |
| 認証 | 任意（Bearer Token） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `lineage_id` | string | 必須 | - | 対象の系統識別子 |

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | 系統別の統合理解度集計が正常に取得された場合 |
| 404 Not Found | リソース不在 | 指定系統IDが存在しない場合 |

### 3.2 成功レスポンス例 (200 OK)

```json
{
  "lineage_id": "sess_root_001",
  "title": "微分系統",
  "total_unique_concepts": 18,
  "high_count": 10,
  "medium_count": 4,
  "low_count": 3,
  "unknown_count": 1,
  "mastery_rate": 0.555
}
```
