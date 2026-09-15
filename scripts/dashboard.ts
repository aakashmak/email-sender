/**
 * Local email-tracking dashboard.
 *
 * Starts a tiny HTTP server that reads from Supabase and serves a single-page
 * dashboard showing totals, the follow-up funnel, opens (with times), and replies.
 *
 * Usage: npm run dashboard   (then open http://localhost:4545)
 */
import * as dotenv from 'dotenv';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const PORT = parseInt(process.env.DASHBOARD_PORT || '4545', 10);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

interface SendRow {
  tracking_id: string;
  email: string;
  email_type: string;
  subject: string | null;
  sent_at: string;
}
interface OpenRow {
  tracking_id: string;
  opened_at: string;
  user_agent: string | null;
}
interface TrackingRow {
  email: string;
  status: string;
  reply_count: number | null;
  replied_at: string | null;
  initial_sent_date: string | null;
  last_sent_date: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  initial: 'Initial',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
};

// Supabase/PostgREST caps an unpaginated select at 1000 rows by default.
// email_sends passed that a while ago (2400+ rows), so a plain select was
// silently missing everything after the first 1000 — the dashboard stopped
// reflecting new sends once that happened. Page with .range() instead.
const PAGE_SIZE = 1000;
async function fetchAllPaginated<T>(table: string, columns: string): Promise<T[]> {
  const allRows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    const page = (data || []) as T[];
    allRows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows;
}

async function buildStats() {
  const [sends, opens, tracking, contactsRes, archivedRes] = await Promise.all([
    fetchAllPaginated<SendRow>('email_sends', 'tracking_id, email, email_type, subject, sent_at'),
    fetchAllPaginated<OpenRow>('email_opens', 'tracking_id, opened_at, user_agent'),
    fetchAllPaginated<TrackingRow>(
      'email_tracking',
      'email, status, reply_count, replied_at, initial_sent_date, last_sent_date'
    ),
    supabase.from('contacts').select('email', { count: 'exact', head: true }),
    supabase.from('archived_contacts').select('email', { count: 'exact', head: true }),
  ]);

  // --- Totals by type ---
  const sentByType: Record<string, number> = {};
  for (const s of sends) sentByType[s.email_type] = (sentByType[s.email_type] || 0) + 1;

  // --- Funnel by status ---
  const byStatus: Record<string, number> = {};
  for (const t of tracking) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  // --- Opens (join opens -> sends via tracking_id) ---
  // Gmail's bot pre-fetches the pixel within seconds of delivery to cache it.
  // We treat opens that fire within PREFETCH_WINDOW_SECONDS of the send as that
  // automatic prefetch (bot), and later opens as likely-human. See dashboard note.
  const PREFETCH_WINDOW_SECONDS = parseInt(process.env.OPEN_PREFETCH_WINDOW_SECONDS || '90', 10);
  const sendByTracking = new Map(sends.map((s) => [s.tracking_id, s]));

  const classified = opens.map((o) => {
    const send = sendByTracking.get(o.tracking_id);
    let isHuman = true; // default when we can't match a send time (e.g. orphan open)
    if (send) {
      const delaySeconds =
        (new Date(o.opened_at).getTime() - new Date(send.sent_at).getTime()) / 1000;
      isHuman = delaySeconds >= PREFETCH_WINDOW_SECONDS;
    }
    return { open: o, send, isHuman };
  });

  const humanOpens = classified.filter((c) => c.isHuman);
  const autoOpens = classified.length - humanOpens.length;

  // A send counts as "human-opened" if it has at least one human open.
  const humanOpenedSendIds = new Set(humanOpens.map((c) => c.open.tracking_id));
  const humanOpenedSends = sends.filter((s) => humanOpenedSendIds.has(s.tracking_id)).length;
  const humanOpenRate = sends.length ? humanOpenedSends / sends.length : 0;

  // Opens per day (human only) for the chart
  const opensByDay: Record<string, number> = {};
  for (const c of humanOpens) {
    const day = c.open.opened_at.slice(0, 10);
    opensByDay[day] = (opensByDay[day] || 0) + 1;
  }

  // Recent human opens, newest first
  const recentOpens = [...humanOpens]
    .sort((a, b) => b.open.opened_at.localeCompare(a.open.opened_at))
    .slice(0, 50)
    .map((c) => ({
      email: c.send?.email || 'unknown',
      type: TYPE_LABELS[c.send?.email_type || ''] || c.send?.email_type || '?',
      subject: c.send?.subject || '',
      opened_at: c.open.opened_at,
    }));

  // --- Replies ---
  const replied = tracking.filter((t) => (t.reply_count || 0) > 0 || t.status === 'replied');
  const contactsEmailed = tracking.filter((t) => t.initial_sent_date).length;
  const replyRate = contactsEmailed ? replied.length / contactsEmailed : 0;
  const recentReplies = [...replied]
    .sort((a, b) => (b.replied_at || '').localeCompare(a.replied_at || ''))
    .slice(0, 50)
    .map((t) => ({ email: t.email, reply_count: t.reply_count || 1, replied_at: t.replied_at }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      contacts: contactsRes.count || 0,
      archived: archivedRes.count || 0,
      emailsSent: sends.length,
      contactsEmailed,
    },
    sentByType,
    byStatus,
    opens: {
      total: opens.length,
      humanOpens: humanOpens.length,
      autoOpens,
      humanOpenedSends,
      humanOpenRate,
      prefetchWindowSeconds: PREFETCH_WINDOW_SECONDS,
      opensByDay,
      recent: recentOpens,
    },
    replies: {
      count: replied.length,
      replyRate,
      recent: recentReplies,
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/stats') {
      const stats = await buildStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    // Serve the dashboard page for any other path
    const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }));
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nDashboard running at ${url}`);
  console.log('Press Ctrl+C to stop.\n');

  // Best-effort open in default browser
  const opener =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(opener, () => { /* ignore if it fails */ });
});
