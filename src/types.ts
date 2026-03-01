import { z } from 'zod';

// --- Configuration ---

export const ImapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(993),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean().default(true),
  rejectUnauthorized: z.boolean().default(true),
});

export type ImapConfig = z.infer<typeof ImapConfigSchema>;

export function loadConfig(): ImapConfig {
  return ImapConfigSchema.parse({
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT ? parseInt(process.env.IMAP_PORT, 10) : undefined,
    username: process.env.IMAP_USERNAME,
    password: process.env.IMAP_PASSWORD,
    tls: process.env.IMAP_TLS !== undefined ? process.env.IMAP_TLS !== 'false' : undefined,
    rejectUnauthorized: process.env.IMAP_REJECT_UNAUTHORIZED !== undefined ? process.env.IMAP_REJECT_UNAUTHORIZED !== 'false' : undefined,
  });
}

export const SmtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(587),
  username: z.string().min(1),
  password: z.string().min(1),
  tls: z.boolean().default(true),
  rejectUnauthorized: z.boolean().default(true),
});

export type SmtpConfig = z.infer<typeof SmtpConfigSchema>;

export function loadSmtpConfig(): SmtpConfig | null {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USERNAME || !process.env.SMTP_PASSWORD) {
    return null;
  }
  return SmtpConfigSchema.parse({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
    username: process.env.SMTP_USERNAME,
    password: process.env.SMTP_PASSWORD,
    tls: process.env.SMTP_TLS !== undefined ? process.env.SMTP_TLS !== 'false' : undefined,
    rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== undefined ? process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' : undefined,
  });
}

// --- Shared types ---

export interface ParsedAddress {
  name: string;
  address: string;
}

export interface ParsedMessage {
  uid: number;
  messageId: string;
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  date: string;
  inReplyTo: string | null;
  references: string | null;
  text: string | null;
  html: string | null;
  hasAttachments: boolean;
  attachmentCount: number;
  attachments: { filename: string | null; contentType: string; size: number }[];
}

export interface MessageSummary {
  uid: number;
  messageId: string;
  flags: string[];
  subject: string;
  from: ParsedAddress;
  date: string;
  hasAttachments: boolean;
}

export interface MailboxInfo {
  path: string;
  name: string;
  specialUse: string | null;
  totalMessages: number | null;
  unseenMessages: number | null;
}
