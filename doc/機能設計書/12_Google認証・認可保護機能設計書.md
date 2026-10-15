# 12. Google認証・認可保護 機能設計書

## 1. 機能概要

- Google OAuth 2.0 / Firebase Authentication を利用したセキュアなサインイン基盤を提供する。
- フロントエンドから送付された Bearer トークン（JWT）をバックエンドで検証し、ユーザー一意の `sub` クレームを抽出して各リソースの所有者識別子（`user_id`）として利用する。
- トークンが存在しない環境でも即座に体験できるよう、`guest_user` へのフォールバック機構を提供する。

## 2. 入出力

### 入力
- リクエストヘッダー: `Authorization: Bearer <ID_TOKEN>`

### 出力
- 解決されたユーザーコンテキスト (`user_id`: string, `is_guest`: boolean)
- 認可エラー時は 401 Unauthorized または 403 Forbidden

## 3. 処理フロー

```mermaid
flowchart TD
    Req[クライアントリクエスト受信] --> CheckHeader{Authorizationヘッダーがあるか？}
    
    CheckHeader -->|なし| GuestMode[guest_user として解決]
    CheckHeader -->|あり| ExtractToken[Bearerトークン抽出]
    
    ExtractToken --> VerifyToken{Google / Firebase 公開鍵でJWT署名・有効期限検証}
    VerifyToken -->|有効| ExtractSub[sub クレームを user_id として取得]
    VerifyToken -->|失効 / 不正署名| AuthFail[401 Unauthorized 返却]
    
    ExtractSub --> CheckAccess{操作対象リソースの所有者と一致するか？}
    GuestMode --> CheckAccess
    
    CheckAccess -->|一致| Allow[処理継続 (200 OK)]
    CheckAccess -->|不一致| Deny[403 Forbidden 返却]
```

1. **トークンの抽出**:
   - `FastAPI Depends(get_current_user)` 内で `request.headers.get("Authorization")` をパース。
2. **トークン検証**:
   - 本番環境では Google Auth ライブラリまたは Firebase Admin SDK を用いて公開鍵証明書と照合し、署名・発行者（iss）・有効期限（exp）を検証。
3. **ユーザーコンテキストの注入**:
   - 有効な場合、一意な `sub` 値をエンドポイントの引数へ注入。
4. **テナント分離・認可チェック**:
   - セッション取得・更新時、DB内の `session.user_id` とリクエストユーザーを照合。他人のセッションであれば `PermissionError`（403）を即時送出。

## 4. バリデーション

- `Authorization` ヘッダーのプレフィックスが `Bearer ` であること。
- トークンが期限切れでないこと。

## 5. エラーハンドリング

| エラーケース | ステータスコード | レスポンス例 | 備考 |
| --- | --- | --- | --- |
| 無効なJWTトークン | 401 | `{"detail": "認証トークンが無効または期限切れです。"}` | 署名エラー |
| 他人のリソースへのアクセス | 403 | `{"detail": "このリソースに対するアクセス権限がありません。"}` | 認可エラー |
