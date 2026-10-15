# ==============================================================================
# Terraform 基本設定および GCP プロバイダ定義
# ==============================================================================
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    # Firebase Hosting 関連リソースは beta プロバイダで管理
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }
}

# Google Cloud プロバイダ初期化
provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# アプリケーション稼働および運用に必要なGCP APIリスト
locals {
  services = [
    "run.googleapis.com",              # Cloud Run サービス実行
    "firestore.googleapis.com",        # Firestore データベースアクセス
    "aiplatform.googleapis.com",       # Vertex AI (Gemini / Text Embeddings)
    "artifactregistry.googleapis.com", # コンテナイメージ管理
    "cloudbuild.googleapis.com",       # Cloud Build (コンテナビルド)
    "iam.googleapis.com",              # IAM権限管理
    "monitoring.googleapis.com",       # Cloud Monitoring (コストアラート監視)
    "logging.googleapis.com",          # Cloud Logging
    "firebase.googleapis.com",         # Firebase 管理
    "firebasehosting.googleapis.com"   # Firebase Hosting (フロントエンド配信)
  ]
}

# 定義したGCP APIの一括有効化リソース
resource "google_project_service" "enabled_apis" {
  for_each                   = toset(local.services)
  project                    = var.project_id
  service                    = each.key
  disable_on_destroy         = false # destroy時にもAPIは無効化しない
  disable_dependent_services = false
}

