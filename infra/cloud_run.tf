# ==============================================================================
# Cloud Run サービス定義 (フルスタック Web アプリケーション)
# ==============================================================================
resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # インターネット経由のトラフィックを全面許可

  template {
    # オートスケーリング制限: コスト抑制のため最大インスタンス数を3に設定
    scaling {
      max_instance_count = 3
    }

    # 実行サービスアカウントの指定
    service_account = google_service_account.app_sa.email

    containers {
      # Artifact Registryから最新イメージを取得
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.cloud_run_repo.repository_id}/${var.service_name}:latest"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        startup_cpu_boost = true  # コールドスタート高速化のためのCPUブースト
        cpu_idle          = false # 会話・先読み・作業リースの更新をHTTP応答後も進める
      }

      # アプリケーション実行時環境変数
      env {
        name  = "GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name  = "GEMINI_BACKEND"
        value = "adk"
      }
      env {
        name  = "GEMINI_MODEL"
        value = "gemini-3.5-flash-lite"
      }
      env {
        name  = "GEMINI_THINKING_BUDGET"
        value = "0"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = "global"
      }
      env {
        name  = "DATABASE_BACKEND"
        value = "firestore"
      }
      env {
        name  = "ENABLE_ADK_SEARCH"
        value = "false"
      }
      env {
        name  = "ENABLE_ADK_QUESTION_SEARCH"
        value = "false"
      }

      # 起動確認プローブ (ヘルスチェック)
      startup_probe {
        failure_threshold = 1
        period_seconds    = 240
        timeout_seconds   = 240
        tcp_socket {
          port = 8080
        }
      }
    }
  }

  # gcloud等による外部デプロイでのイメージ更新とのコンフリクトを防止
  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_project_service.enabled_apis,
    google_artifact_registry_repository.cloud_run_repo
  ]
}

# 未認証ユーザー (パブリックインターネット) からのHTTPアクセスを許可
resource "google_cloud_run_v2_service_iam_member" "public_access" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

