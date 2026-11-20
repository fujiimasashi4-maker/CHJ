-- Apply to the existing COMMENTS_DB before deploying notification-aware code.
-- Safe to reapply. Existing comments are deliberately not queued or emailed.
CREATE TABLE IF NOT EXISTS notification_outbox (
    comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at INTEGER NOT NULL,
    lease_until INTEGER,
    lease_token TEXT,
    accepted_at INTEGER,
    last_error TEXT CHECK (last_error IN ('delivery_failed', 'timeout')),
    CHECK ((lease_until IS NULL) = (lease_token IS NULL))
);

CREATE INDEX IF NOT EXISTS notifications_due
    ON notification_outbox (accepted_at, next_attempt_at, created_at, comment_id);

CREATE TRIGGER IF NOT EXISTS comments_notification_enqueue
AFTER INSERT ON comments
BEGIN
    INSERT INTO notification_outbox (comment_id, created_at, next_attempt_at)
    VALUES (NEW.id, NEW.created_at, NEW.created_at);
END;
