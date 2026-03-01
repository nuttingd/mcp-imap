#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, loadSmtpConfig } from './types.js';
import { ImapClient } from './imap-client.js';
import { SmtpClient } from './smtp-client.js';

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
