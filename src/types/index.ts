// Contact with generated emails stored directly
export interface Contact {
  email: string;  // PRIMARY KEY
  name: string;
  title?: string;
  company_name?: string;

  // Email generation flag
  is_emails_enriched: boolean;

  // Generated emails
  initial_email_subject?: string;
  initial_email?: string;
  follow_up_1_subject?: string;
  follow_up_1?: string;
  follow_up_2_subject?: string;
  follow_up_2?: string;
  follow_up_3_subject?: string;
  follow_up_3?: string;

  // Research summary
  research_summary?: string;

  // Resume type matched to contact's role/job posting
  resume_type?: string;

  // Metadata
  created_at?: string;
  updated_at?: string;
}

// Tracking record for each contact
export interface TrackingRecord {
  email: string;  // FK to contacts
  campaign_id: string;
  status: TrackingStatus;
  initial_sent_date: string | null;
  last_sent_date: string | null;
  follow_up_count: number;
  next_follow_up_date: string | null;
  error_message: string | null;
  thread_id: string | null;         // Gmail thread ID for threading follow-ups
  gmail_message_id: string | null;  // RFC 2822 Message-ID for In-Reply-To header
  created_at: string;
  updated_at: string;
}

export type TrackingStatus =
  | 'pending'
  | 'sent'
  | 'follow_up_1'
  | 'follow_up_2'
  | 'follow_up_3'
  | 'completed'
  | 'error'
  | 'bounced';

// Generated emails from Claude
export interface GeneratedEmails {
  research_summary?: string;
  resume_type?: string;
  initial_email_subject: string;
  initial_email: string;
  follow_up_1_subject: string;
  follow_up_1: string;
  follow_up_2_subject: string;
  follow_up_2: string;
  follow_up_3_subject: string;
  follow_up_3: string;
}

// Result of sending an email
export interface SendResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  gmailMessageId?: string; // RFC 2822 Message-ID for In-Reply-To header
  error?: string;
}

// Campaign run result
export interface RunResult {
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// Generation result
export interface GenerationResult {
  generated: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// Email task for scheduler
export interface EmailTask {
  type: 'initial' | 'follow_up';
  contact: Contact;
  record: TrackingRecord | null;
  templateName: string;
}

// Parsed template from markdown file
export interface ParsedTemplate {
  name: string;
  subject: string;
  body: string;
}

// Rendered email ready to send
export interface RenderedEmail {
  subject: string;
  body: string;
}

// Application configuration
export interface Config {
  gmail: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    senderEmail: string;
  };
  supabase: {
    url: string;
    anonKey: string;
  };
  campaign: {
    dailyLimit: number;
    followUpIntervals: number[];
    maxFollowUps: number;
    campaignId: string;
  };
  paths: {
    templatesDir: string;
    promptsDir: string;
  };
  dryRun: boolean;
}
