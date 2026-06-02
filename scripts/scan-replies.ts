/**
 * Daily reply scan.
 *
 * Scans every tracking record that has a Gmail thread_id and records whether
 * the contact replied (timestamp + count), setting status = 'replied'. Unlike
 * the lazy check in send-runner, this catches replies even after the sequence
 * has finished.
 *
 * Usage: npx ts-node scripts/scan-replies.ts
 * Runs in CI via .github/workflows/scan-replies.yml.
 */
import { loadConfig } from '../src/config';
import { getSupabaseClient } from '../src/db/supabase';
import { GmailAuthClient } from '../src/auth/gmail-auth';
import { GmailSender } from '../src/email/gmail-sender';

interface TrackingRow {
  email: string;
  status: string;
  thread_id: string | null;
  reply_count: number;
}

async function main(): Promise<void> {
  const config = loadConfig(false);
  const supabase = getSupabaseClient();

  // Load records that have a thread and aren't already terminal-error/bounced.
  const { data, error } = await supabase
    .from('email_tracking')
    .select('email, status, thread_id, reply_count')
    .not('thread_id', 'is', null);

  if (error) throw new Error(`Failed to load tracking records: ${error.message}`);

  const rows = (data || []) as TrackingRow[];
  console.log(`Scanning ${rows.length} threads for replies...`);

  const authClient = new GmailAuthClient(config.gmail);
  const gmail = await authClient.getGmailClient();
  const sender = new GmailSender(gmail, config.gmail.senderEmail);

  let newReplies = 0;
  let checked = 0;

  for (const row of rows) {
    if (!row.thread_id) continue;
    checked++;

    const info = await sender.getReplyInfo(row.thread_id);
    if (!info.replied) continue;

    // Update if newly replied or the reply count changed.
    if (row.status !== 'replied' || info.replyCount !== row.reply_count) {
      const { error: updateError } = await supabase
        .from('email_tracking')
        .update({
          status: 'replied',
          replied_at: info.firstReplyAt,
          reply_count: info.replyCount,
          next_follow_up_date: null,
          updated_at: new Date().toISOString(),
        })
        .eq('email', row.email);

      if (updateError) {
        console.warn(`  [WARN] ${row.email}: ${updateError.message}`);
      } else {
        if (row.status !== 'replied') newReplies++;
        console.log(`  [REPLIED] ${row.email} (${info.replyCount} reply/replies, first ${info.firstReplyAt})`);
      }
    }
  }

  console.log(`\nDone. Checked ${checked} threads, ${newReplies} new replies recorded.`);
}

main().catch((e) => {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
