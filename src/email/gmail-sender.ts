import { gmail_v1 } from 'googleapis';
import { SendResult } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export type EmailType = 'initial' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3';

interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  emailType: EmailType;
  attachResume?: boolean;
  resumePath?: string;      // Override default resume path for this send
  threadId?: string;        // Gmail thread ID — threads follow-up into same conversation
  gmailMessageId?: string;  // RFC 2822 Message-ID of previous email for In-Reply-To header
}

function buildSignatures(): { followup: string; initial: string } {
  const name = process.env.SENDER_NAME || 'Sender';
  const linkedin = process.env.SENDER_LINKEDIN || '#';
  return {
    followup: `Best,<br>\n${name}<br>\n<a href="${linkedin}">LinkedIn</a>`,
    initial: `Best,<br>\n${name}<br>\n<a href="${linkedin}">LinkedIn</a><br>\n<br>\n<span style="color: #e67e22; font-size: 0.9em;">P.S. Just so you know, I found your email through Apollo. I like to be pretty transparent about these things, so no need to worry about any data leaks!</span>`,
  };
}

export class GmailSender {
  private gmail: gmail_v1.Gmail;
  private senderEmail: string;
  private labelIdCache: Map<string, string> = new Map();
  private resumePath: string;

  constructor(gmail: gmail_v1.Gmail, senderEmail: string) {
    this.gmail = gmail;
    this.senderEmail = senderEmail;
    this.resumePath = path.join(process.cwd(), 'temp', 'Resume.pdf');
  }

  async initialize(): Promise<void> {
    // Pre-fetch label ID
    await this.fetchOrCreateLabel('Cold Mails');
    console.log('Gmail sender initialized with signatures and labels');
  }

  private getSignature(emailType: EmailType): string {
    const sigs = buildSignatures();
    return emailType === 'initial' ? sigs.initial : sigs.followup;
  }

  private async fetchOrCreateLabel(labelName: string): Promise<string | null> {
    try {
      // Check cache first
      if (this.labelIdCache.has(labelName)) {
        return this.labelIdCache.get(labelName)!;
      }

      // List existing labels
      const response = await this.gmail.users.labels.list({
        userId: 'me',
      });

      const labels = response.data.labels || [];
      const existingLabel = labels.find(
        (l) => l.name?.toLowerCase() === labelName.toLowerCase()
      );

      if (existingLabel && existingLabel.id) {
        this.labelIdCache.set(labelName, existingLabel.id);
        return existingLabel.id;
      }

      // Create label if it doesn't exist
      const createResponse = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name: labelName,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });

      if (createResponse.data.id) {
        this.labelIdCache.set(labelName, createResponse.data.id);
        return createResponse.data.id;
      }

      return null;
    } catch (error) {
      console.warn(`Could not fetch/create label "${labelName}":`, error);
      return null;
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<SendResult> {
    const { to, subject, body, emailType, attachResume = false, resumePath, threadId, gmailMessageId } = options;
    const effectiveResumePath = resumePath || this.resumePath;

    try {
      // Get the appropriate signature based on email type
      const signature = this.getSignature(emailType);

      // Build HTML body with signature
      const htmlBody = this.buildHtmlBody(body, signature);

      // Construct the email message
      let message: string;
      if (attachResume && emailType === 'initial' && fs.existsSync(effectiveResumePath)) {
        message = await this.createMessageWithAttachment(to, subject, htmlBody, effectiveResumePath);
      } else {
        message = this.createHtmlMessage(to, subject, htmlBody, gmailMessageId);
      }

      // Base64url encode the message
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      // Send the email (include threadId to thread follow-ups into same conversation)
      const result = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          ...(threadId ? { threadId } : {}),
        },
      });

      const messageId = result.data.id;
      const sentThreadId = result.data.threadId;

      // Add label to the sent message
      if (messageId) {
        await this.addLabelToMessage(messageId, 'Cold Mails');
      }

      // Fetch the RFC 2822 Message-ID for future In-Reply-To headers
      let rfcMessageId: string | undefined;
      if (messageId) {
        rfcMessageId = await this.fetchRfcMessageId(messageId);
      }

      return {
        success: true,
        messageId: messageId || undefined,
        threadId: sentThreadId || undefined,
        gmailMessageId: rfcMessageId,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (this.isRateLimitError(error)) {
        return {
          success: false,
          error: 'Rate limit exceeded. Please try again later.',
        };
      }

      if (this.isAuthError(error)) {
        return {
          success: false,
          error: 'Authentication failed. Refresh token may have expired.',
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private buildHtmlBody(body: string, signature: string): string {
    // Convert plain text body to HTML (preserve line breaks)
    const htmlBody = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

    // Combine body with signature (signature is already HTML from Gmail)
    if (signature) {
      return `<div>${htmlBody}</div><br><div>${signature}</div>`;
    }

    return `<div>${htmlBody}</div>`;
  }

  private createHtmlMessage(to: string, subject: string, htmlBody: string, inReplyTo?: string): string {
    const lines = [
      `From: ${this.senderEmail}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: text/html; charset=utf-8`,
    ];

    if (inReplyTo) {
      lines.push(`In-Reply-To: ${inReplyTo}`);
      lines.push(`References: ${inReplyTo}`);
    }

    lines.push('', htmlBody);

    return lines.join('\r\n');
  }

  private async fetchRfcMessageId(messageId: string): Promise<string | undefined> {
    try {
      const msg = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID'],
      });
      const header = msg.data.payload?.headers?.find((h) => h.name === 'Message-ID');
      return header?.value || undefined;
    } catch {
      return undefined;
    }
  }

  private async createMessageWithAttachment(
    to: string,
    subject: string,
    htmlBody: string,
    resumePath?: string
  ): Promise<string> {
    const boundary = `boundary_${Date.now()}`;

    // Read the resume file
    const effectivePath = resumePath || this.resumePath;
    const resumeContent = fs.readFileSync(effectivePath);
    const resumeBase64 = resumeContent.toString('base64');
    const resumeFilename = path.basename(effectivePath);

    const lines = [
      `From: ${this.senderEmail}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      htmlBody,
      '',
      `--${boundary}`,
      `Content-Type: application/pdf; name="${resumeFilename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${resumeFilename}"`,
      '',
      resumeBase64,
      '',
      `--${boundary}--`,
    ];

    return lines.join('\r\n');
  }

  private async addLabelToMessage(messageId: string, labelName: string): Promise<void> {
    try {
      const labelId = await this.fetchOrCreateLabel(labelName);
      if (labelId) {
        await this.gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            addLabelIds: [labelId],
          },
        });
      }
    } catch (error) {
      console.warn(`Could not add label to message:`, error);
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code: number }).code === 429;
    }
    return false;
  }

  private isAuthError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code: number }).code;
      return code === 401 || code === 403;
    }
    return false;
  }
}
