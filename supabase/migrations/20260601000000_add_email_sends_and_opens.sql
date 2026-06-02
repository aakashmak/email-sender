-- Open tracking: per-send log + open events.
--
-- email_sends  : one row per actual email sent (source of truth for "total emails").
--                tracking_id is the opaque token embedded in the open-tracking pixel.
-- email_opens  : one row per open event, linked to a send via tracking_id.

CREATE TABLE IF NOT EXISTS email_sends (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tracking_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_type TEXT NOT NULL,            -- initial | follow_up_1 | follow_up_2 | follow_up_3
  subject TEXT,
  gmail_message_id TEXT,
  thread_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_sends_email ON email_sends (email);
CREATE INDEX IF NOT EXISTS idx_email_sends_sent_at ON email_sends (sent_at);

CREATE TABLE IF NOT EXISTS email_opens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tracking_id TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_opens_tracking_id ON email_opens (tracking_id);
CREATE INDEX IF NOT EXISTS idx_email_opens_opened_at ON email_opens (opened_at);
