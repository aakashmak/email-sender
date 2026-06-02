-- Reply tracking: record when and how many replies a contact sent.
-- The existing `replied` status is kept; these add the timestamp + count
-- populated by the daily reply scan (scripts/scan-replies.ts).

ALTER TABLE email_tracking
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_count INTEGER NOT NULL DEFAULT 0;
