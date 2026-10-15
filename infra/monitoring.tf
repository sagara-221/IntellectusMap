# ==============================================================================
# Cloud Monitoring 監視 & コストアラート定義
# 用途: AI呼び出しコスト超過や急増ログを検知し、指定メールアドレスへ通知
# ==============================================================================

# アラートメール送信用通知チャンネル
resource "google_monitoring_notification_channel" "cost_alert_email" {
  display_name = "Cost Alert Email Notification"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.enabled_apis]
}

# ログベースのコスト急増アラートポリシー
# Cloud Runログ内にCOST_ALERT_TRIGGEREDが出現した場合に発報
resource "google_monitoring_alert_policy" "cost_alert_policy" {
  display_name = "Knowledge Gap Mapper - Cost Threshold Alert"
  combiner     = "OR"

  conditions {
    display_name = "Cost threshold exceeded"

    condition_matched_log {
      filter = "resource.type=\"cloud_run_revision\" AND textPayload=~\"COST_ALERT_TRIGGERED\""
    }
  }

  notification_channels = [
    google_monitoring_notification_channel.cost_alert_email.id
  ]

  alert_strategy {
    auto_close = "1800s" # 30分経過後に自動クローズ
    notification_rate_limit {
      period = "300s" # 通知スパム防止: 最短5分間隔
    }
  }

  documentation {
    content   = "Knowledge Gap Mapper でセッションコストまたは急増が検出されました。詳細は Cloud Run ログおよび Firestore を確認してください。"
    mime_type = "text/markdown"
  }

  depends_on = [
    google_project_service.enabled_apis,
    google_monitoring_notification_channel.cost_alert_email
  ]
}

