# 10. 会話診断履歴取得 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | GET |
| URL | /api/sessions/{session_id}/chat |
| 概要 | 指定セッションで行われた対話チャットの会話履歴、発言リスト、抽出された観察エビデンスおよびバックグラウンド処理状態を取得する |
| 認証 | 任意（Bearer Token） |
| レスポンス形式 | application/json |

## 2. リクエストパラメータ

### 2.1 パスパラメータ

| パラメータ名 | 型 | 必須 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| `session_id` | string | 必須 | `sess_` prefix | 対象の診断セッションID |

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 取得成功 | 正常に対話履歴および状態が取得された場合 |
| 404 Not Found | リソース不在 | 指定セッションIDが存在しない場合 |

### 3.2 成功レスポンス例 (200 OK)

```json
{
  "conversations": [
    {
      "conversation_id": "conv_1a2b3c4d",
      "created_at": "2026-10-04T10:15:30Z",
      "messages": [
        {
          "message_id": "msg_01",
          "role": "user",
          "text": "微分係数と接線の傾きってどう関係しているの？",
          "timestamp": "2026-10-04T10:15:30Z"
        },
        {
          "message_id": "msg_02",
          "role": "assistant",
          "text": "グラフ上の特定の一点における接線の傾きそのものが、その点での微分係数です。",
          "timestamp": "2026-10-04T10:15:32Z"
        }
      ]
    }
  ],
  "observations": [
    {
      "observation_id": "obs_01",
      "concept_id": "meaning_slope",
      "confidence": 0.9,
      "demonstrated": ["微分係数と接線の傾きの幾何学的対応を理解している"],
      "missing": []
    }
  ],
  "background_status": "idle"
}
```
