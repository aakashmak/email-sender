import { randomBytes } from 'crypto';
import { getSupabaseClient } from './supabase';
import { EmailType } from '../email/gmail-sender';

/** Generate an opaque token for the open-tracking pixel. */
export function generateTrackingId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Build the open-tracking pixel URL for a given tracking id.
 * Returns undefined if TRACKING_PIXEL_BASE_URL is not configured (open
 * tracking disabled), in which case no pixel is embedded.
 */
export function buildPixelUrl(trackingId: string): string | undefined {
  const base = process.env.TRACKING_PIXEL_BASE_URL;
  if (!base) return undefined;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}t=${trackingId}`;
}

interface LogSendParams {
  trackingId: string;
  email: string;
  emailType: EmailType;
  subject: string;
  gmailMessageId?: string | null;
  threadId?: string | null;
}

/** Record one actual send in email_sends (source of truth for totals + opens). */
export async function logSend(params: LogSendParams): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from('email_sends').insert({
    tracking_id: params.trackingId,
    email: params.email.toLowerCase(),
    email_type: params.emailType,
    subject: params.subject,
    gmail_message_id: params.gmailMessageId || null,
    thread_id: params.threadId || null,
  });

  if (error) {
    // Don't fail the send over a logging error — just warn.
    console.warn(`  [WARN] Could not log send for ${params.email}: ${error.message}`);
  }
}
