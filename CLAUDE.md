# CLAUDE.md

@.claude/docs/architecture.md
@.claude/docs/database.md

This file provides context for Claude Code and other AI assistants working on this project.

## Project Overview

Cold email campaign system with AI-powered email generation. Uses Claude CLI to generate personalized emails with web research, stores in Supabase, and sends via Gmail API on a schedule through GitHub Actions.

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **AI**: Claude CLI with web search for email generation
- **Database**: Supabase (PostgreSQL)
- **Email**: Gmail API with OAuth 2.0
- **Scheduling**: GitHub Actions (cron - weekdays 9 AM CST)

## Two Workflows

> **Tracking dashboard:** `npm run dashboard` opens a local web dashboard (totals, follow-up funnel, opens with timestamps, replies). Reads from Supabase. See "Email Tracking Dashboard" below.

### 1. Generate Emails (Local)
```bash
npm run generate
```
- Runs locally on your machine
- Uses Claude CLI with `--allowedTools WebSearch`
- Generates 4 emails per contact (initial + 3 follow-ups)
- Stores in Supabase contacts table

### 2. Send Emails (GitHub Actions)
```bash
npm run send          # Live
npm run send:dry-run  # Preview
```
- Runs via GitHub Actions on schedule
- Reads generated emails from Supabase
- Sends via Gmail API
- Tracks status in email_tracking table

## Key Files

| File | Purpose |
|------|---------|
| `src/campaign/generation-runner.ts` | Orchestrates email generation with Claude CLI |
| `src/campaign/send-runner.ts` | Orchestrates email sending via Gmail |
| `src/ai/claude-cli.ts` | Wrapper for Claude CLI (uses Git Bash on Windows) |
| `src/ai/prompt-builder.ts` | Builds prompts from templates and contact data |
| `src/ai/email-parser.ts` | Parses 4 emails from Claude output |
| `src/db/contacts.ts` | Supabase contact queries |
| `src/db/tracking-manager.ts` | Email tracking status management |
| `src/db/sends.ts` | Logs each send to `email_sends` + builds open-tracking pixel URL |
| `src/email/gmail-sender.ts` | Gmail API integration (embeds tracking pixel, `getReplyInfo`) |
| `scripts/scan-replies.ts` | Daily reply scan (records `replied_at`/`reply_count`; delays instead of stopping follow-ups for out-of-office auto-replies via `ooo_count`) |
| `scripts/dashboard.ts` | Local dashboard server (`/api/stats` + serves `dashboard/index.html`) |
| `supabase/functions/track-open/` | Edge Function: open-tracking pixel endpoint |
| `data/prompts/*.md` | Email style guidelines |

## Utility Scripts

```bash
# Import contacts from Apollo CSV
npx ts-node scripts/import-contacts.ts file.csv

# Add single contact
npx ts-node scripts/add-contact.ts email name title company

# Reset contact to regenerate emails
npx ts-node scripts/reset-contact.ts email

# View generated emails
npx ts-node scripts/view-emails.ts email

# Open the tracking dashboard (totals, opens, replies) at http://localhost:4545
npm run dashboard

# Scan Gmail threads for replies (records replied_at + reply_count)
npm run scan-replies

# Stop follow-ups and archive a contact (prospect replied/unsubscribed)
npx ts-node scripts/stop-and-archive.ts email

# Bulk archive all completed contacts
npx ts-node scripts/archive-completed.ts

# Permanently block an address that bounced ("address not found", DNS failure) —
# removes it from contacts/tracking/archived and blocklists it so future
# CSV imports skip it even if it reappears in a fresh export
npx ts-node scripts/mark-bounced.ts email "reason"

# Refresh Gmail OAuth token (run every ~7 days, auto-updates GitHub secret)
npx ts-node scripts/auth-setup.ts
```

## Data Flow

```
Apollo CSV → import-contacts.ts → Supabase (is_emails_enriched=false)
                                         ↓
                              npm run generate (local)
                                         ↓
                              Supabase (is_emails_enriched=true)
                                         ↓
                              Review/edit in Supabase UI
                                         ↓
                              npm run send (GitHub Actions)
                                         ↓
                              Gmail → email_tracking updated
```

## Email Style Guidelines

Located in `data/prompts/`:

| File | Purpose |
|------|---------|
| `initial.md` | Initial email writing style - direct, confident, brief |
| `followup.md` | Follow-up progressions - shorter, new angles |
| `research-guidelines.md` | What to research about company/person |

Key style points:
- Direct and confident ("perfect fit" not "might be relevant")
- Brief (3-4 sentences for initial)
- No em-dashes, no philosophical language
- No signatures (Gmail adds automatically)
- Start with "Hi [First Name],"

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | Both | Supabase project URL |
| `SUPABASE_ANON_KEY` | Both | Supabase anon key |
| `GMAIL_CLIENT_ID` | Send | OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Send | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Send | OAuth refresh token |
| `SENDER_EMAIL` | Send | Gmail address |
| `DAILY_LIMIT` | Send | Max emails per run (default: 50) |
| `FOLLOW_UP_INTERVALS` | Send | Days between follow-ups (default: 3,7,10) |
| `TRACKING_PIXEL_BASE_URL` | Send | Open-tracking Edge Function URL. If unset, no pixel is embedded (open tracking off). e.g. `https://<ref>.supabase.co/functions/v1/track-open` |
| `DASHBOARD_PORT` | Dashboard | Local dashboard port (default: 4545) |
| `OPEN_PREFETCH_WINDOW_SECONDS` | Dashboard | Opens within this many seconds of the send are treated as Gmail's automatic bot prefetch, not a human open (default: 90) |

## Email Tracking Dashboard

Local web dashboard for campaign metrics. Run `npm run dashboard` and open `http://localhost:4545`.

Shows: total emails sent (by type), the follow-up funnel (by status), open rate + open timestamps, and replies (count, rate, timestamps). Auto-refreshes every 30s.

**Data sources:**
- **Totals / follow-ups** — `email_sends` and `email_tracking`.
- **Opens** — the open-tracking pixel (`<img>` embedded in each email) hits the `track-open` Edge Function, which logs `email_opens`. The dashboard splits these into **human opens** vs **Gmail bot prefetch** using timing: an open within `OPEN_PREFETCH_WINDOW_SECONDS` (default 90s) of the send is the automatic Google proxy prefetch; later opens are counted as human. This can't be perfect — both go through Google's proxy with the same user-agent, and Gmail serves many human opens from cache that never reach us — so "human opens" is directional and undercounts.
- **Replies** — populated by `npm run scan-replies` (run daily by `.github/workflows/scan-replies.yml`), which scans Gmail threads and records `replied_at`/`reply_count`. A reply that's an out-of-office auto-responder (detected by subject/snippet keywords like "out of office", "automatic reply", "on leave") does **not** stop follow-ups — instead `next_follow_up_date` is pushed to the day after the stated return date (or +5 days if no date is found), tracked via `ooo_count` so the same auto-reply isn't reprocessed on the next scan.

**One-time setup for open tracking:**
```bash
# 1. Apply the new migrations to your Supabase project
supabase db push

# 2. Deploy the open-tracking Edge Function (public — verify_jwt=false in config.toml)
supabase functions deploy track-open

# 3. Set TRACKING_PIXEL_BASE_URL locally (.env) and as a GitHub `email-sender` env secret:
#    https://<project-ref>.supabase.co/functions/v1/track-open
```
Already-sent emails have no pixel, so opens only accrue for emails sent after setup. The reply scan backfills replies for any thread still visible in Gmail.

## Gotchas

- **Windows + Claude CLI**: Uses Git Bash for reliable piping
- **OAuth refresh tokens**: Expire in 7 days — Google Cloud project must stay in **Testing mode** (Gmail sensitive scopes require full Google verification to work in Production mode, which is overkill for a personal tool). Run `npx ts-node scripts/auth-setup.ts` to refresh; it auto-updates the GitHub `email-sender` environment secret via `gh`.
- **OAuth flow**: Uses localhost redirect (`http://localhost:3000/oauth2callback`) — OOB flow (`urn:ietf:wg:oauth:2.0:oob`) is fully deprecated by Google since Jan 2023.
- **Gmail limits**: 500/day for personal accounts - stay well under
- **Follow-up timing**: Intervals are 3, 7, 10 days from initial send
- **`pending` status does NOT trigger sends** — initial emails only send when there is NO tracking record. If a contact has a `pending` record (e.g. from a failed run), delete it so the send runner picks it up.
- **Batch generation**: Contacts are grouped by company — one Claude CLI call per company, not per contact. Much faster for multiple contacts at the same company.
- **Generation output cleanup**: After generation, check for `**` and trailing `---` artifacts with the node cleanup script. These can leak from Claude's markdown formatting.

## Common Maintenance Actions

### Stop follow-ups and archive a contact (replied/unsubscribed)
```bash
# Stops follow-ups AND moves contact to archived_contacts in one step
npx ts-node scripts/stop-and-archive.ts contact@example.com
```

To archive all completed contacts in bulk:
```bash
npx ts-node scripts/archive-completed.ts
```

### Fix failed send run (OAuth expired)
```bash
# 1. Refresh the token
npx ts-node scripts/auth-setup.ts

# 2. Delete error/pending tracking records so initial emails resend
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
supabase.from('email_tracking').delete().in('status', ['error', 'pending']).select('email').then(({data}) => console.log('Deleted:', data.map(r=>r.email)));
"

# 3. Trigger the workflow
gh workflow run send-campaign.yml
```

### Check and clean email artifacts (** and ---)
```bash
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const fields = ['initial_email_subject','initial_email','follow_up_1_subject','follow_up_1','follow_up_2_subject','follow_up_2','follow_up_3_subject','follow_up_3'];
function clean(s) { return s ? s.replace(/\*\*/g, '').replace(/\n*---+\s*$/g, '').trim() : s; }
async function main() {
  const { data } = await supabase.from('contacts').select('email,' + fields.join(',')).eq('is_emails_enriched', true);
  for (const row of data) {
    const update = {};
    fields.forEach(k => { const c = clean(row[k]); if (c !== row[k]) update[k] = c; });
    if (Object.keys(update).length) {
      await supabase.from('contacts').update(update).eq('email', row.email);
      console.log('Fixed:', row.email);
    }
  }
  console.log('Done.');
}
main();
"
```

### Trigger GitHub Actions workflow manually
```bash
gh workflow run send-campaign.yml

# Check recent runs
gh run list --workflow=send-campaign.yml --limit=5

# View logs of a failed run
gh run view <run-id> --log-failed
```
