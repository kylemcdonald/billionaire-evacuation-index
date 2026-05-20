CREATE TABLE IF NOT EXISTS notification_renewal_reminders (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  alert_id TEXT,
  email_hash TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscriber_id) REFERENCES notification_signups (id),
  FOREIGN KEY (alert_id) REFERENCES notification_alerts (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_renewal_reminders_subscription_period
  ON notification_renewal_reminders (stripe_subscription_id, current_period_end);

CREATE INDEX IF NOT EXISTS idx_notification_renewal_reminders_status
  ON notification_renewal_reminders (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_notification_renewal_reminders_subscriber
  ON notification_renewal_reminders (subscriber_id);
