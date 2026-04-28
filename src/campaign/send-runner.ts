import { loadConfig } from '../config';
import { getEnrichedContacts } from '../db/contacts';
import { TrackingManager } from '../db/tracking-manager';
import { GmailAuthClient } from '../auth/gmail-auth';
import { GmailSender } from '../email/gmail-sender';
import { RateLimiter } from '../email/rate-limiter';
import { Contact, RunResult, TrackingStatus } from '../types';

interface EmailToSend {
  contact: Contact;
  subject: string;
  body: string;
  type: 'initial' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3';
}

export class SendRunner {
  private config: ReturnType<typeof loadConfig>;

  constructor(config: ReturnType<typeof loadConfig>) {
    this.config = config;
  }

  async run(): Promise<RunResult> {
    const result: RunResult = {
      sent: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    console.log('\n=== Email Sender ===');
    console.log(`Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`Daily Limit: ${this.config.campaign.dailyLimit}`);

    // 1. Load enriched contacts (with generated emails)
    console.log('\nLoading enriched contacts from Supabase...');
    const contacts = await getEnrichedContacts();

    if (contacts.length === 0) {
      console.log('No enriched contacts found.');
      return result;
    }

    console.log(`Found ${contacts.length} contacts with generated emails`);

    // 2. Load tracking data
    console.log('Loading tracking data...');
    const trackingManager = new TrackingManager();
    await trackingManager.load();

    // 3. Build list of emails to send
    const emailsToSend = this.buildEmailQueue(contacts, trackingManager);

    if (emailsToSend.length === 0) {
      console.log('No emails to send today.');
      return result;
    }

    console.log(`\nEmails to send: ${emailsToSend.length}`);

    // 4. Initialize Gmail
    let sender: GmailSender | null = null;
    if (!this.config.dryRun) {
      console.log('Initializing Gmail client...');
      const authClient = new GmailAuthClient(this.config.gmail);
      const gmail = await authClient.getGmailClient();
      sender = new GmailSender(gmail, this.config.gmail.senderEmail);
      await sender.initialize(); // Fetch signatures and labels
    }

    // 5. Initialize rate limiter
    const rateLimiter = new RateLimiter(this.config.campaign.dailyLimit);

    // 6. Send emails
    for (const email of emailsToSend) {
      if (!rateLimiter.canSend()) {
        console.log('\nDaily limit reached, stopping.');
        break;
      }

      console.log(`\nSending to: ${email.contact.email}`);
      console.log(`  Type: ${email.type}`);
      console.log(`  Subject: ${email.subject}`);

      // Ensure tracking record exists
      let record = trackingManager.getRecord(email.contact.email);
      if (!record) {
        record = await trackingManager.createRecord(
          email.contact.email,
          this.config.campaign.campaignId
        );
      }

      if (this.config.dryRun) {
        console.log('  [DRY RUN] Would send');
        result.sent++;
      } else {
        // Pass thread info for follow-ups to chain them into the same conversation
        const sendResult = await sender!.sendEmail({
          to: email.contact.email,
          subject: email.subject,
          body: email.body,
          emailType: email.type,
          attachResume: email.type === 'initial',
          resumePath: this.getResumePath(email.contact.resume_type),
          threadId: email.type !== 'initial' ? record.thread_id || undefined : undefined,
          gmailMessageId: email.type !== 'initial' ? record.gmail_message_id || undefined : undefined,
        });

        if (sendResult.success) {
          // Calculate new status and follow-up info
          const newStatus = this.getNextStatus(email.type);
          const followUpCount = this.getFollowUpCount(email.type);
          const nextFollowUpDate = this.calculateNextFollowUpDate(followUpCount);

          // Update tracking (save thread info from initial email for follow-up threading)
          await trackingManager.updateRecord(email.contact.email, {
            status: newStatus,
            initial_sent_date: record.initial_sent_date || new Date().toISOString(),
            last_sent_date: new Date().toISOString(),
            follow_up_count: followUpCount,
            next_follow_up_date: nextFollowUpDate,
            ...(email.type === 'initial' ? {
              thread_id: sendResult.threadId || null,
              gmail_message_id: sendResult.gmailMessageId || null,
            } : {}),
          });

          result.sent++;
          console.log(`  [OK] Sent (ID: ${sendResult.messageId})`);
        } else {
          await trackingManager.updateRecord(email.contact.email, {
            status: 'error',
            error_message: sendResult.error || 'Unknown error',
          });

          result.failed++;
          result.errors.push(`${email.contact.email}: ${sendResult.error}`);
          console.log(`  [ERROR] ${sendResult.error}`);
        }

        await rateLimiter.waitForNextSlot();
      }

      rateLimiter.recordSent();
    }

    // 7. Summary
    console.log('\n=== Send Summary ===');
    console.log(`Sent: ${result.sent}`);
    console.log(`Failed: ${result.failed}`);
    console.log(`Skipped: ${result.skipped}`);

    if (result.errors.length > 0) {
      console.log('\nErrors:');
      result.errors.forEach((e) => console.log(`  - ${e}`));
    }

    return result;
  }

  private buildEmailQueue(
    contacts: Contact[],
    trackingManager: TrackingManager
  ): EmailToSend[] {
    const emailsToSend: EmailToSend[] = [];
    const today = new Date().toISOString().split('T')[0];

    for (const contact of contacts) {
      const record = trackingManager.getRecord(contact.email);

      // No tracking record = needs initial email
      if (!record) {
        if (contact.initial_email && contact.initial_email_subject) {
          emailsToSend.push({
            contact,
            subject: contact.initial_email_subject,
            body: contact.initial_email,
            type: 'initial',
          });
        }
        continue;
      }

      // Skip completed, error, or bounced
      if (['completed', 'error', 'bounced'].includes(record.status)) {
        continue;
      }

      // Check if due for follow-up
      if (!record.next_follow_up_date || record.next_follow_up_date > today) {
        continue; // Not due yet
      }

      // Determine which follow-up to send based on current status
      const emailToSend = this.getNextEmail(contact, record.status);
      if (emailToSend) {
        emailsToSend.push(emailToSend);
      }
    }

    return emailsToSend;
  }

  private getNextEmail(contact: Contact, currentStatus: TrackingStatus): EmailToSend | null {
    switch (currentStatus) {
      case 'sent':
        // After initial, send follow-up 1
        if (contact.follow_up_1 && contact.follow_up_1_subject) {
          return {
            contact,
            subject: contact.follow_up_1_subject,
            body: contact.follow_up_1,
            type: 'follow_up_1',
          };
        }
        break;
      case 'follow_up_1':
        // After follow-up 1, send follow-up 2
        if (contact.follow_up_2 && contact.follow_up_2_subject) {
          return {
            contact,
            subject: contact.follow_up_2_subject,
            body: contact.follow_up_2,
            type: 'follow_up_2',
          };
        }
        break;
      case 'follow_up_2':
        // After follow-up 2, send follow-up 3
        if (contact.follow_up_3 && contact.follow_up_3_subject) {
          return {
            contact,
            subject: contact.follow_up_3_subject,
            body: contact.follow_up_3,
            type: 'follow_up_3',
          };
        }
        break;
    }
    return null;
  }

  private getResumePath(resumeType?: string): string {
    const base = process.cwd();
    const map: Record<string, string> = {
      data_analyst:     `${base}/temp/Resume_DataAnalyst.pdf`,
      business_analyst: `${base}/temp/Resume_BusinessAnalyst.pdf`,
      ai_engineer:      `${base}/temp/Resume_AI.pdf`,
      data_engineer:    `${base}/temp/Resume_DataEngineer.pdf`,
      data_scientist:   `${base}/temp/Resume_DataScientist.pdf`,
    };
    return map[resumeType || 'data_scientist'] || map['data_scientist'];
  }

  private getNextStatus(emailType: string): TrackingStatus {
    switch (emailType) {
      case 'initial':
        return 'sent';
      case 'follow_up_1':
        return 'follow_up_1';
      case 'follow_up_2':
        return 'follow_up_2';
      case 'follow_up_3':
        return 'completed'; // After follow-up 3, we're done
      default:
        return 'sent';
    }
  }

  private getFollowUpCount(emailType: string): number {
    switch (emailType) {
      case 'initial':
        return 0;
      case 'follow_up_1':
        return 1;
      case 'follow_up_2':
        return 2;
      case 'follow_up_3':
        return 3;
      default:
        return 0;
    }
  }

  private calculateNextFollowUpDate(currentFollowUpCount: number): string | null {
    const intervals = this.config.campaign.followUpIntervals;

    if (currentFollowUpCount >= 3) {
      return null; // No more follow-ups after 3
    }

    if (currentFollowUpCount < intervals.length) {
      const daysUntilNext = intervals[currentFollowUpCount];
      const nextDate = new Date();
      nextDate.setDate(nextDate.getDate() + daysUntilNext);
      return nextDate.toISOString().split('T')[0];
    }

    return null;
  }
}

// CLI entry point
export async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('Starting email send runner...\n');

  try {
    const config = loadConfig(isDryRun);
    const runner = new SendRunner(config);
    const result = await runner.run();

    if (result.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('\nFatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}
