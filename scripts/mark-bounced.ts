/**
 * Mark an email as permanently bounced. Removes it from contacts,
 * email_tracking, and archived_contacts, and adds it to bounced_emails so
 * future CSV imports skip it even if it reappears in a fresh export.
 *
 * Usage: npx ts-node scripts/mark-bounced.ts email@example.com ["reason"]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const email = process.argv[2]?.toLowerCase();
const reason = process.argv[3] || 'bounced';

if (!email || !email.includes('@')) {
  console.error('Usage: npx ts-node scripts/mark-bounced.ts email@example.com ["reason"]');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

(async () => {
  const { error: bounceError } = await supabase
    .from('bounced_emails')
    .upsert({ email, reason, bounced_at: new Date().toISOString() });
  if (bounceError) {
    console.error('Failed to add to bounced_emails:', bounceError.message);
    process.exit(1);
  }

  const { data: c } = await supabase.from('contacts').select('email').eq('email', email).maybeSingle();
  const { data: t } = await supabase.from('email_tracking').select('status').eq('email', email).maybeSingle();
  const { data: a } = await supabase.from('archived_contacts').select('email').eq('email', email).maybeSingle();

  if (t) await supabase.from('email_tracking').delete().eq('email', email);
  if (c) await supabase.from('contacts').delete().eq('email', email);
  if (a) await supabase.from('archived_contacts').delete().eq('email', email);

  console.log(`${email} | contact: ${!!c} | tracking: ${t?.status ?? 'none'} | archived: ${!!a} → marked bounced permanently`);
})();
