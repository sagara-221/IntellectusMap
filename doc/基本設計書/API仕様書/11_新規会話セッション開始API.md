# 11. 新規会話セッション開始 API 詳細仕様

## 1. エンドポイント情報

| 項目 | 内容 |
| --- | --- |
| メソッド | POST |
| URL | /api/sessions/{session_id}/chat/conversations |
| 概要 | 現在の診断セッション内で、新しい話題や別の概念に焦点を当てた新しい対話スレッドを開始する |
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
| `focus_concept_id` | string | 任意 | 存在するノードID | 新規スレッドでフォーカスする概念ID |

## 3. レスポンス仕様

### 3.1 HTTPステータスコード

| ステータスコード | 意味 | 発生条件 |
| --- | --- | --- |
| 200 OK | 作成成功 | 新規会話スレッドが初期化され、会話状態が返却された場合 |
| 404 Not Found | リソース不在 | 指定セッションIDが存在しない場合 |

### 3.2 成功レスポンス例 (200 OK)

```json
{
  "active_conversation_id": "conv_9z8y7x6w",
  "focus_concept_id": "power_rule",
  "background_status": "idle"
}
```
