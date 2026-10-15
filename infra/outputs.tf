# ==============================================================================
# Terraform 出力値定義
# ==============================================================================

# デプロイされたCloud RunサービスのアクセスURL
output "cloud_run_url" {
  description = "Cloud Run Service URL"
  value       = google_cloud_run_v2_service.app.uri
}

# Firebase Hosting のフロントエンドURL (Google OAuth 承認済みJS生成元に登録する)
output "hosting_url" {
  description = "Firebase Hosting URL"
  value       = "https://${var.project_id}.web.app"
}

# コンテナイメージ保管先Artifact Registry ID
output "artifact_registry_id" {
  description = "Artifact Registry ID"
  value       = google_artifact_registry_repository.cloud_run_repo.id
}

# Firestore データベースID
output "firestore_database_id" {
  description = "Firestore Database ID"
  value       = google_firestore_database.database.id
}

# アプリケーション実行サービスアカウントのメールアドレス
output "service_account_email" {
  description = "Application Service Account Email"
  value       = google_service_account.app_sa.email
}

