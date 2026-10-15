# ==============================================================================
# Firebase Hosting (フロントエンド静的配信) 定義
# ==============================================================================

# GCPプロジェクトをFirebaseプロジェクトとして有効化 (デフォルトHostingサイト knowledge-gap-mapper が自動生成)
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [google_project_service.enabled_apis]
}

