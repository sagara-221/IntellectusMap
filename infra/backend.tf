# ==============================================================================
# Terraform Remote Backend 設定
# 用途: チーム開発・CI/CDでのステート整合性を保つため、Google Cloud Storageにtfstateを保存
# ==============================================================================
terraform {
  backend "gcs" {
    bucket = "YOUR_TFSTATE_BUCKET_NAME" # デプロイ環境のGCSバケット名 (例: your-project-id-tfstate)
    prefix = "terraform/state"
  }
}

