-- Permanent blocklist for addresses that have bounced ("address not found",
-- DNS failure, etc). Unlike archived_contacts (replied/completed), these
-- should never be re-imported even if a fresh CSV export includes them again.
CREATE TABLE IF NOT EXISTS bounced_emails (
  email TEXT PRIMARY KEY,
  reason TEXT,
  bounced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
