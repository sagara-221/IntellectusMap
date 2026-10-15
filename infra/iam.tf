# ==============================================================================
# IAM サービスアカウントおよび権限ロール定義
# ==============================================================================

# アプリケーション実行用サービスアカウント
resource "google_service_account" "app_sa" {
  account_id   = "gap-mapper-sa"
  display_name = "Knowledge Gap Mapper Service Account"
}

# Vertex AI 呼び出し権限 (Gemini API / Text Embeddings 実行)
resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.app_sa.email}"
}

# Firestore データベースの読み書き権限
resource "google_project_iam_member" "datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.app_sa.email}"
}

# Cloud Run 実行呼び出し権限
resource "google_project_iam_member" "run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.app_sa.email}"
}

