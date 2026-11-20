-- Apply once to the D1 database bound as COMMENTS_DB.
-- Keep image bytes in bound parameters; never embed BLOB literals in SQL.
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    news TEXT NOT NULL CHECK (news = 'fsf-ashiya-2026-12-12'),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    comment TEXT NOT NULL CHECK (length(comment) <= 2000),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at INTEGER NOT NULL,
    moderated_at INTEGER,
    photo BLOB,
    photo_mime TEXT CHECK (photo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
    ip_hash TEXT,
    request_id TEXT UNIQUE,
    payload_hash TEXT,
    CHECK (length(comment) > 0 OR photo IS NOT NULL),
    CHECK ((photo IS NULL AND photo_mime IS NULL) OR
           (photo IS NOT NULL AND photo_mime IS NOT NULL AND length(photo) BETWEEN 1 AND 750000)),
    CHECK ((request_id IS NULL AND payload_hash IS NULL) OR
           (request_id IS NOT NULL AND payload_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS comments_public_page
    ON comments (news, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS comments_rate_window
    ON comments (ip_hash, created_at);

-- New inserts enqueue atomically; applying this schema never backfills old posts.
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

