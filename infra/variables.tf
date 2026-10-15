# ==============================================================================
# Terraform 入力変数定義
# ==============================================================================

# デプロイ対象のGCPプロジェクトID
variable "project_id" {
  description = "GCP Project ID"
  type        = string
  default     = "your-gcp-project-id"
}

# リソースを配備するGCPリージョン (東京リージョン)
variable "region" {
  description = "GCP Region for resources"
  type        = string
  default     = "asia-northeast1"
}

# Cloud Run サービス名
variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "knowledge-gap-mapper"
}

# Google OAuth ログイン用クライアントID (フロントエンド認証用)
variable "google_client_id" {
  description = "Google OAuth Client ID"
  type        = string
  default     = "your-google-client-id.apps.googleusercontent.com"
}

# コスト上限超過・日次レポート送信先メールアドレス
variable "alert_email" {
  description = "Email address for cost alerts and notifications"
  type        = string
  default     = "admin@example.com"
}



