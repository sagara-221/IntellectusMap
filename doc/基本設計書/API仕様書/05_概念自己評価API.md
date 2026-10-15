# 05. 概念自己評価 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/self-assessment |
| 概要 | 手動探索モードにおいて、問題回答を省略し学習者の自己申告（アンケート）によって概念ノードの理解度レベルを記録・更新する |
| 認証 | 任意（Bearer Token） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | 必須 | `sess_` prefix | 対象の診断セッションID |

### 2.2 リクエストボディ

| フィールド名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `concept_id` | string | 必須 | 存在するノードID（ルート以外） | 自己評価を記録する概念ノードID |
| `level` | string | 必須 | `'high'`, `'medium'`, `'low'`, `'unsure'` | 理解度自己評価レベル（high: 理解している, medium: あいまい, low: 分からない, unsure: 自分では判断できない） |

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 更新成功 | 自己評価が正常に記録され、セッション状態が返却された場合 |
| 400 Bad Request | リクエスト不正 | 診断が完了している、探索モードがmanualでない、またはルート概念に対して送信された場合 |
| 404 Not Found | リソース不在 | 指定された `session_id` または `concept_id` が存在しない場合 |

### 3.2 成功レスポンス例 (200 OK)

更新後の診断セッション全体オブジェクト（`Diagnosis` モデル）が返却される。`self_assessments` 辞書に対象ノードの評価レベルが反映され、理解度ロールアップサマリーが再計算される。

```json
{
  "session_id": "sess_9b4a1c2d3e4f5a6b",
  "theme": "微分",
  "exploration_mode": "manual",
  "self_assessments": {
    "power_identify": {
      "level": "high",
      "origin_map_id": "sess_9b4a1c2d3e4f5a6b"
    }
  },
  "understanding_summaries": {
    "power_identify": {
      "level": "high",
      "confidence_level": "medium",
      "source": "self_report"
    }
  },
  "revision": 4
}
```
