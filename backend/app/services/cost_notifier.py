# ==============================================================================
# コストアラート通知サービス (Cost Notifier)
# 用途: 診断セッションでのAI呼び出しコストが閾値を超過した際、
#       Cloud Monitoringログアラート連携およびSMTPメール通知を発行
# ==============================================================================
import os
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
from app.models.domain import Session

logger = logging.getLogger(__name__)

# 通知設定（環境変数）
ALERT_EMAIL = os.environ.get('ALERT_EMAIL', '').strip()
COST_ALERT_THRESHOLD_JPY = float(os.environ.get('COST_ALERT_THRESHOLD_JPY', '50.0'))
SMTP_HOST = os.environ.get('SMTP_HOST', '')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER = os.environ.get('SMTP_USER', '')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD', '')
SMTP_FROM = os.environ.get('SMTP_FROM', ALERT_EMAIL)

# 送信済みセッションの追跡（同一セッションでの過剰送信防止キャッシュ）
_notified_sessions: set[str] = set()



def check_and_notify_cost_event(session: Session, force: bool = False) -> Optional[dict]:
    """
    セッションのコストが閾値を超えた場合、または完了時にイベント駆動で通知を発行。
    Cloud Monitoring のログベースアラートと直接SMTPメール送信の両方に対応。
    """
    cost = getattr(session, 'cost_summary', None)
    if not cost or cost.total_tokens == 0:
        return None

    jpy = cost.estimated_cost_jpy
    is_completed = getattr(session, 'complete', False)
    threshold_exceeded = jpy >= COST_ALERT_THRESHOLD_JPY

    if not force and not threshold_exceeded and not is_completed:
        return None

    # 重複送信防止（完了時の1回、または閾値到達時の1回）
    event_key = f"{session.session_id}_{'completed' if is_completed else 'threshold'}"
    if event_key in _notified_sessions and not force:
        return None
    _notified_sessions.add(event_key)

    report = {
        'session_id': session.session_id,
        'theme': session.theme,
        'user_id': getattr(session, 'user_id', 'guest_user'),
        'total_tokens': cost.total_tokens,
        'prompt_tokens': cost.prompt_tokens,
        'candidates_tokens': cost.candidates_tokens,
        'estimated_cost_usd': cost.estimated_cost_usd,
        'estimated_cost_jpy': cost.estimated_cost_jpy,
        'is_completed': is_completed,
        'by_agent': {k: v.model_dump() for k, v in cost.by_agent.items()},
    }

    # 1. Cloud Monitoring 連携用ログ出力（ログベースアラートでメール通知を自動起動）
    logger.warning(
        "[COST_ALERT_TRIGGERED] Session %s (Theme: '%s') reached cost ¥%.2f ($%.4f) | Tokens: %d | User: %s",
        session.session_id, session.theme, jpy, cost.estimated_cost_usd, cost.total_tokens, report['user_id']
    )

    # 2. SMTP が設定されている場合は直接メール送信
    if SMTP_HOST and ALERT_EMAIL:
        try:
            _send_direct_email(report)
        except Exception as e:
            logger.error("Failed to send direct cost alert email: %s", e)

    return report


def _send_direct_email(report: dict) -> None:
    subject = f"【AIコスト通知】セッション {report['theme']} の利用費: ¥{report['estimated_cost_jpy']:.2f}"
    body = f"""
AI利用コスト通知レポート:

- セッションID: {report['session_id']}
- テーマ: {report['theme']}
- ユーザーID: {report['user_id']}
- 推定費用: ¥{report['estimated_cost_jpy']:.2f} (約 ${report['estimated_cost_usd']:.4f} USD)
- 総トークン数: {report['total_tokens']:,} tokens
  - 入力トークン: {report['prompt_tokens']:,} tokens
  - 出力トークン: {report['candidates_tokens']:,} tokens
- 状態: {'診断完了' if report['is_completed'] else '進行中'}

エージェント別内訳:
"""
    for agent, stat in report['by_agent'].items():
        avg_sec = round(stat.get('avg_latency_ms', 0) / 1000.0, 1) if stat.get('avg_latency_ms') else None
        latency_info = f" | 平均{avg_sec}秒" if avg_sec else ""
        body += f"  - {agent}: {stat.get('calls', 0)}回 | {stat.get('total_tokens', 0):,} tokens{latency_info} | ¥{stat.get('estimated_cost_jpy', 0.0):.2f}\n"

    msg = MIMEMultipart()
    msg['From'] = SMTP_FROM
    msg['To'] = ALERT_EMAIL
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
        server.starttls()
        if SMTP_USER and SMTP_PASSWORD:
            server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)
    logger.info("Successfully sent cost alert email to %s", ALERT_EMAIL)
