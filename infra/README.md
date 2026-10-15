# Knowledge Gap Mapper - Terraform インフラ構成 (IaC)

Google Cloud 上のリソース全般をコード管理するための Terraform 構成。

---

## 1. 管理リソース一覧

- **プロジェクト API**: `run`, `firestore`, `aiplatform`, `artifactregistry`, `cloudbuild`, `iam`
- **Artifact Registry**: `cloud-run-source-deploy` (Docker リポジトリ)
- **Firestore**: `(default)` (Native モード)
- **IAM / サービスアカウント**: `gap-mapper-sa` (Vertex AI および Firestore 権限)
- **Cloud Run**: `knowledge-gap-mapper` (アジア北東1、パブリック公開)

---

## 2. コマンド手順

### 初期化
```bash
cd infra
terraform init
```

### 既存リソースの取り込み (Import)
既存の稼働リソースを壊さずに Terraform 管理下に移行する場合：

```bash
# 1. サービスアカウント
terraform import google_service_account.app_sa projects/<your-project-id>/serviceAccounts/gap-mapper-sa@<your-project-id>.iam.gserviceaccount.com

# 2. Firestore データベース
terraform import google_firestore_database.database "(default)"

# 3. Artifact Registry リポジトリ
terraform import google_artifact_registry_repository.cloud_run_repo projects/<your-project-id>/locations/asia-northeast1/repositories/cloud-run-source-deploy

# 4. Cloud Run サービス
terraform import google_cloud_run_v2_service.app projects/<your-project-id>/locations/asia-northeast1/services/knowledge-gap-mapper
```

### 適用 / 更新
```bash
terraform plan
terraform apply
```

### 破棄 (全リソース削除)
```bash
terraform destroy
```
