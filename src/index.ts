#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadConfig, loadSmtpConfig } from './types.js';
import { ImapClient } from './imap-client.js';
import { SmtpClient } from './smtp-client.js';

// Attachments larger than this returned inline risk blowing up tool response tokens.
// When no save_to is specified, auto-save to a temp file instead.
const INLINE_SIZE_LIMIT = 1024 * 256; // 256 KB

const config = loadConfig();
const imapClient = new ImapClient(config);

const smtpConfig = loadSmtpConfig();
const smtpClient = smtpConfig ? new SmtpClient(smtpConfig) : null;

const server = new McpServer({
  name: 'mcp-imap',
  version: '1.0.0',
});

// --- Tools ---

server.tool(
  'list_mailboxes',
  'List all available email mailboxes/folders with message counts',
  async () => {
    try {
      const mailboxes = await imapClient.listMailboxes();
      return {
        content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `IMAP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_messages',
  'List email message summaries in a mailbox. Returns subject, sender, date, flags. Most recent first. Use get_message to read full content.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox path (e.g. "INBOX", "Sent", "Archive")'),
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of messages to return'),
    offset: z.number().int().min(0).default(0).describe('Number of messages to skip (for pagination)'),
    unseen_only: z.boolean().default(false).describe('If true, only return unread messages'),
    since: z.string().optional().describe('Only messages after this date (ISO 8601, e.g. "2025-03-01")'),
    before: z.string().optional().describe('Only messages before this date (ISO 8601)'),
  },
  async ({ mailbox, limit, offset, unseen_only, since, before }) => {
    try {
      const result = await imapClient.listMessages(mailbox, {
        limit,
        offset,
        unseenOnly: unseen_only,
        since,
        before,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `IMAP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'search_messages',
  'Search for emails matching criteria. Returns message summaries. Use get_message to read full content of specific messages.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox to search in'),
    from: z.string().optional().describe('Search by sender address or name'),
    to: z.string().optional().describe('Search by recipient address or name'),
    subject: z.string().optional().describe('Search in subject line'),
    body: z.string().optional().describe('Search in message body (slower)'),
    since: z.string().optional().describe('Messages after this date (ISO 8601)'),
    before: z.string().optional().describe('Messages before this date (ISO 8601)'),
    flagged: z.boolean().optional().describe('Filter by flagged/starred status'),
    unseen: z.boolean().optional().describe('Filter by unread status'),
    limit: z.number().int().min(1).max(100).default(50).describe('Maximum results to return'),
  },
  async ({ mailbox, from, to, subject, body, since, before, flagged, unseen, limit }) => {
    try {
      const messages = await imapClient.searchMessages(mailbox, {
        from, to, subject, body, since, before, flagged, unseen, limit,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `IMAP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_message',
  'Get the full content of a specific email message by UID. Returns subject, sender, recipients, date, text body, HTML body, and attachment metadata.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message'),
    uid: z.number().int().positive().describe('Message UID (from list_messages or search_messages results)'),
  },
  async ({ mailbox, uid }) => {
    try {
      const message = await imapClient.getMessage(mailbox, uid);
      if (!message) {
        return {
          content: [{ type: 'text', text: `Message with UID ${uid} not found in ${mailbox}` }],
          isError: true,
        };
      }

      // When text body is available, omit HTML to save tokens
      const output = {
        ...message,
        html: message.text && message.html
          ? '(HTML version available but text version shown above)'
          : message.html,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `IMAP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_attachment',
  'Download a specific attachment from an email by IMAP part number. Use get_message first to see available attachments and their part numbers. Provide save_to to write directly to disk (recommended for non-text files) — parent directories are created automatically. Large attachments (>256KB) are auto-saved to a temp file when save_to is omitted.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message'),
    uid: z.number().int().positive().describe('Message UID'),
    part: z.string().describe('IMAP part number from the attachment metadata (e.g. "2", "1.2")'),
    save_to: z.string().optional().describe('File path to save the attachment to. Directories are created automatically. When omitted, small files are returned inline; large files auto-save to a temp path.'),
    max_size: z.number().int().positive().default(10_485_760).describe('Maximum download size in bytes (default 10MB)'),
  },
  async ({ mailbox, uid, part, save_to, max_size }) => {
    try {
      const attachment = await imapClient.getAttachment(mailbox, uid, part, max_size);
      const mimeType = attachment.contentType.toLowerCase();
      const meta = {
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        part: attachment.part,
      };

      // --- Write to disk when save_to is provided ---
      if (save_to) {
        const resolvedPath = path.resolve(save_to);
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, attachment.content);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ...meta, saved_to: resolvedPath }, null, 2),
          }],
        };
      }

      // --- Auto-save large non-text/non-image attachments to temp file ---
      const isText = mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
      const isImage = mimeType.startsWith('image/');

      if (!isText && !isImage && attachment.size > INLINE_SIZE_LIMIT) {
        const ext = attachment.filename ? path.extname(attachment.filename) : '';
        const basename = attachment.filename
          ? path.basename(attachment.filename, ext)
          : `attachment-uid${uid}-part${part}`;
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-imap-'));
        const tmpPath = path.join(tmpDir, `${basename}${ext}`);
        await fs.writeFile(tmpPath, attachment.content);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...meta,
              saved_to: tmpPath,
              note: 'Attachment was too large to return inline. Saved to a temp file.',
            }, null, 2),
          }],
        };
      }

      // --- Inline responses for small / text / image content ---

      // Images: return as viewable image content block
      if (isImage) {
        return {
          content: [
            {
              type: 'image' as const,
              data: attachment.content.toString('base64'),
              mimeType: attachment.contentType,
            },
            { type: 'text' as const, text: JSON.stringify(meta) },
          ],
        };
      }

      // Text types: decode to UTF-8
      if (isText) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...meta,
              content: attachment.content.toString('utf-8'),
            }, null, 2),
          }],
        };
      }

      // Small binary: base64 inline
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...meta,
            encoding: 'base64',
            content: attachment.content.toString('base64'),
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'save_as_eml',
  'Save the original raw RFC 2822 email to disk as an .eml file. This is the byte-for-byte original message including all headers, MIME structure, signatures, and attachments. Parent directories are created automatically.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message'),
    uid: z.number().int().positive().describe('Message UID'),
    save_to: z.string().describe('File path to save the .eml file to (directories created automatically)'),
  },
  async ({ mailbox, uid, save_to }) => {
    try {
      const raw = await imapClient.getRawMessage(mailbox, uid);
      if (!raw) {
        return {
          content: [{ type: 'text', text: `Message with UID ${uid} not found in ${mailbox}` }],
          isError: true,
        };
      }
      const resolvedPath = path.resolve(save_to);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, raw.source);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            messageId: raw.envelope.messageId,
            subject: raw.envelope.subject,
            date: raw.envelope.date,
            size: raw.source.length,
            saved_to: resolvedPath,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'move_message',
  'Move one or more email messages to another mailbox/folder. Accepts a single UID or an array of UIDs for batch operations.',
  {
    mailbox: z.string().default('INBOX').describe('Source mailbox containing the message(s)'),
    uid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]).describe('Message UID or array of UIDs to move'),
    destination: z.string().describe('Destination mailbox path (e.g. "Archive", "Trash")'),
  },
  async ({ mailbox, uid, destination }) => {
    try {
      const success = await imapClient.moveMessage(mailbox, uid, destination);
      const label = Array.isArray(uid) ? `${uid.length} messages` : `Message ${uid}`;
      return {
        content: [{
          type: 'text',
          text: success
            ? `${label} moved from ${mailbox} to ${destination}`
            : `Failed to move ${label}`,
        }],
        isError: !success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `IMAP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'mark_message',
  'Mark one or more email messages as read/unread or flagged/unflagged. Accepts a single UID or an array of UIDs for batch operations.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message(s)'),
    uid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]).describe('Message UID or array of UIDs to update'),
    action: z.enum(['read', 'unread', 'flagged', 'unflagged']).describe('Action to perform'),
  },
  async ({ mailbox, uid, action }) => {
    try {
      const success = await imapClient.markMessage(mailbox, uid, action);
      const label = Array.isArray(uid) ? `${uid.length} messages` : `Message ${uid}`;
      return {
        content: [{
          type: 'text',
          text: success
            ? `${label} marked as ${action}`
            : `Failed to mark ${label} as ${action}`,
        }],
        isError: !success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `IMAP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// --- SMTP Tools (conditional) ---

if (smtpClient) {
  server.tool(
    'send_message',
    'Compose and send a new email message via SMTP',
    {
      to: z.string().describe('Recipient email address(es), comma-separated'),
      cc: z.string().optional().describe('CC recipient(s), comma-separated'),
      bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Plain text body of the email'),
      html: z.string().optional().describe('Optional HTML body (plain text body is always sent alongside)'),
    },
    async ({ to, cc, bcc, subject, body, html }) => {
      try {
        const result = await smtpClient.send({ to, cc, bcc, subject, text: body, html });
        return {
          content: [{ type: 'text', text: `Message sent successfully. Message-ID: ${result.messageId}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `SMTP error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'reply_message',
    'Reply to an existing email message. Automatically sets threading headers (In-Reply-To, References) and quotes the original message.',
    {
      mailbox: z.string().default('INBOX').describe('Mailbox containing the original message'),
      uid: z.number().int().positive().describe('UID of the message to reply to'),
      body: z.string().describe('Reply body text'),
      reply_all: z.boolean().default(false).describe('If true, reply to all recipients (Reply-All)'),
    },
    async ({ mailbox, uid, body, reply_all }) => {
      try {
        const original = await imapClient.getMessage(mailbox, uid);
        if (!original) {
          return {
            content: [{ type: 'text', text: `Message with UID ${uid} not found in ${mailbox}` }],
            isError: true,
          };
        }
        const result = await smtpClient.reply(original, { body, replyAll: reply_all });
        return {
          content: [{ type: 'text', text: `Reply sent successfully. Message-ID: ${result.messageId}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'forward_message',
    'Forward an existing email message to another recipient. Includes the original message body with a forwarded-message header.',
    {
      mailbox: z.string().default('INBOX').describe('Mailbox containing the original message'),
      uid: z.number().int().positive().describe('UID of the message to forward'),
      to: z.string().describe('Recipient email address(es) to forward to'),
      body: z.string().optional().describe('Optional commentary to prepend above the forwarded message'),
    },
    async ({ mailbox, uid, to, body }) => {
      try {
        const original = await imapClient.getMessage(mailbox, uid);
        if (!original) {
          return {
            content: [{ type: 'text', text: `Message with UID ${uid} not found in ${mailbox}` }],
            isError: true,
          };
        }
        const result = await smtpClient.forward(original, { to, body });
        return {
          content: [{ type: 'text', text: `Message forwarded successfully. Message-ID: ${result.messageId}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
async function shutdown() {
  await imapClient.disconnect();
  if (smtpClient) await smtpClient.disconnect();
  await server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
