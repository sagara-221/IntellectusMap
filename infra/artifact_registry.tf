# ==============================================================================
# Google Artifact Registry リポジトリ定義
# 用途: Cloud Run デプロイ用 Docker コンテナイメージの保管
# ==============================================================================
resource "google_artifact_registry_repository" "cloud_run_repo" {
  repository_id = "cloud-run-source-deploy"
  location      = var.region
  format        = "DOCKER"
  description   = "Cloud Run Source Deployments"

  depends_on = [google_project_service.enabled_apis]
}

