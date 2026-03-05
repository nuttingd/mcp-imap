#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const API_BASE = process.env.IMAP_API_URL || 'http://localhost:4748';

// ── HTTP helper ───────────────────────────────────────────────────

async function api<T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    let detail: string;
    try { detail = JSON.parse(text).error || text; } catch { detail = text; }
    throw new Error(`${method} ${apiPath} → ${res.status}: ${detail}`);
  }

  // Handle binary responses (raw message, attachments)
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json() as Promise<T>;
  }
  // Return the response itself for binary handling
  return res as unknown as T;
}

async function apiBinary(method: string, apiPath: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const url = `${API_BASE}${apiPath}`;
  const res = await fetch(url, { method });

  if (!res.ok) {
    const text = await res.text();
    let detail: string;
    try { detail = JSON.parse(text).error || text; } catch { detail = text; }
    throw new Error(`${method} ${apiPath} → ${res.status}: ${detail}`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const disposition = res.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^";\s]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : 'download';
  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), contentType, filename };
}

// ── Auto-start server ─────────────────────────────────────────────

async function ensureServer(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return; // Server already running
  } catch { /* not running */ }

  console.error('mcp-imap: HTTP server not running, starting...');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const serverPath = path.join(__dirname, 'server.js');

  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  // Poll until ready (30s timeout)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      console.error('mcp-imap: HTTP server started');
      return;
    } catch { /* keep polling */ }
  }
  throw new Error('mcp-imap: HTTP server failed to start within 30s');
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new McpServer({
  name: 'mcp-imap',
  version: '1.0.0',
});

// ── Tools ─────────────────────────────────────────────────────────

server.tool(
  'list_mailboxes',
  'List all available email mailboxes/folders with message counts',
  async () => {
    const result = await api('GET', '/api/mailboxes');
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
    since: z.string().optional().describe('Only messages after this date (ISO 8601)'),
    before: z.string().optional().describe('Only messages before this date (ISO 8601)'),
  },
  async ({ mailbox, limit, offset, unseen_only, since, before }) => {
    const qs = new URLSearchParams({ mailbox, limit: String(limit), offset: String(offset) });
    if (unseen_only) qs.set('unseen_only', 'true');
    if (since) qs.set('since', since);
    if (before) qs.set('before', before);
    const result = await api('GET', `/api/messages?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'search_messages',
  'Search for emails matching criteria. Returns message summaries. Use get_message to read full content.',
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
    const qs = new URLSearchParams({ mailbox, limit: String(limit) });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (subject) qs.set('subject', subject);
    if (body) qs.set('body', body);
    if (since) qs.set('since', since);
    if (before) qs.set('before', before);
    if (flagged !== undefined) qs.set('flagged', String(flagged));
    if (unseen !== undefined) qs.set('unseen', String(unseen));
    const result = await api('GET', `/api/search?${qs}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_message',
  'Get the full content of a specific email message by UID. Returns subject, sender, recipients, date, text body, HTML body, and attachment metadata.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message'),
    uid: z.number().int().positive().describe('Message UID'),
  },
  async ({ mailbox, uid }) => {
    const qs = new URLSearchParams({ mailbox });
    const message = await api<Record<string, unknown>>('GET', `/api/messages/${uid}?${qs}`);

    // Omit HTML when text is available to save tokens
    if (message.text && message.html) {
      message.html = '(HTML version available but text version shown above)';
    }
    return { content: [{ type: 'text', text: JSON.stringify(message, null, 2) }] };
  },
);

server.tool(
  'get_attachment',
  'Download a specific attachment from an email by IMAP part number. Returns binary content with correct Content-Type. Use get_message first to see available attachments.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message'),
    uid: z.number().int().positive().describe('Message UID'),
    part: z.string().describe('IMAP part number from attachment metadata (e.g. "2", "1.2")'),
  },
  async ({ mailbox, uid, part }) => {
    const qs = new URLSearchParams({ mailbox });
    const { buffer, contentType, filename } = await apiBinary('GET', `/api/messages/${uid}/attachments/${part}?${qs}`);

    const meta = { filename, contentType, size: buffer.length, part };
    const mimeType = contentType.toLowerCase();

    // Images: return as viewable image content block
    if (mimeType.startsWith('image/')) {
      return {
        content: [
          { type: 'image' as const, data: buffer.toString('base64'), mimeType: contentType },
          { type: 'text' as const, text: JSON.stringify(meta) },
        ],
      };
    }

    // Text: decode to UTF-8
    if (mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...meta, content: buffer.toString('utf-8') }, null, 2) }],
      };
    }

    // Binary: base64
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...meta, encoding: 'base64', content: buffer.toString('base64') }, null, 2) }],
    };
  },
);

server.tool(
  'get_raw_message',
  'Download the raw RFC 2822 email (.eml). Returns metadata; use the HTTP API directly for the binary stream.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message'),
    uid: z.number().int().positive().describe('Message UID'),
  },
  async ({ mailbox, uid }) => {
    const qs = new URLSearchParams({ mailbox });
    const { buffer, filename } = await apiBinary('GET', `/api/messages/${uid}/raw?${qs}`);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ uid, filename, size: buffer.length, note: `Raw .eml available at ${API_BASE}/api/messages/${uid}/raw?mailbox=${encodeURIComponent(mailbox)}` }, null, 2),
      }],
    };
  },
);

server.tool(
  'move_message',
  'Move one or more email messages to another mailbox/folder.',
  {
    mailbox: z.string().default('INBOX').describe('Source mailbox'),
    uid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]).describe('Message UID or array of UIDs'),
    destination: z.string().describe('Destination mailbox path'),
  },
  async ({ mailbox, uid, destination }) => {
    if (Array.isArray(uid)) {
      const result = await api('POST', '/api/messages/batch/move', { mailbox, uids: uid, destination });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    const result = await api('POST', `/api/messages/${uid}/move`, { mailbox, destination });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'mark_message',
  'Mark one or more email messages as read/unread or flagged/unflagged.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the message(s)'),
    uid: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1)]).describe('Message UID or array of UIDs'),
    action: z.enum(['read', 'unread', 'flagged', 'unflagged']).describe('Action to perform'),
  },
  async ({ mailbox, uid, action }) => {
    if (Array.isArray(uid)) {
      const result = await api('POST', '/api/messages/batch/mark', { mailbox, uids: uid, action });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    const result = await api('POST', `/api/messages/${uid}/mark`, { mailbox, action });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'send_message',
  'Compose and send a new email message via SMTP. Returns 503 if SMTP is not configured.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated'),
    cc: z.string().optional().describe('CC recipient(s)'),
    bcc: z.string().optional().describe('BCC recipient(s)'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Plain text body'),
    html: z.string().optional().describe('Optional HTML body'),
  },
  async ({ to, cc, bcc, subject, body, html }) => {
    const result = await api('POST', '/api/send', { to, cc, bcc, subject, body, html });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'reply_message',
  'Reply to an existing email. Automatically sets threading headers and quotes the original.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the original message'),
    uid: z.number().int().positive().describe('UID of the message to reply to'),
    body: z.string().describe('Reply body text'),
    reply_all: z.boolean().default(false).describe('If true, reply to all recipients'),
  },
  async ({ mailbox, uid, body, reply_all }) => {
    const result = await api('POST', `/api/messages/${uid}/reply`, { mailbox, body, reply_all });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'forward_message',
  'Forward an existing email to another recipient.',
  {
    mailbox: z.string().default('INBOX').describe('Mailbox containing the original message'),
    uid: z.number().int().positive().describe('UID of the message to forward'),
    to: z.string().describe('Recipient email address(es)'),
    body: z.string().optional().describe('Optional commentary to prepend'),
  },
  async ({ mailbox, uid, to, body }) => {
    const result = await api('POST', `/api/messages/${uid}/forward`, { mailbox, to, body });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start ─────────────────────────────────────────────────────────

async function main() {
  await ensureServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-imap MCP proxy started (stdio)');
}

main().catch((err) => {
  console.error('MCP startup error:', err);
  process.exit(1);
});
