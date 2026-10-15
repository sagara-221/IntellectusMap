# ==============================================================================
# Cloud Firestore データベース定義 (Native モード)
# 用途: 診断セッション、マップ系譜、知識ノード、回答履歴などの永続化
# ==============================================================================
resource "google_firestore_database" "database" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # 意図しないデータ喪失を防止（Terraform destroy時にもDB自体は破棄せず保持）
  deletion_policy = "ABANDON"

  depends_on = [google_project_service.enabled_apis]
}

