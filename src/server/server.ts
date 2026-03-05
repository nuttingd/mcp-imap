#!/usr/bin/env node

import cors from 'cors';
import express from 'express';
import { loadConfig, loadSmtpConfig } from '../shared/types.js';
import { ImapClient } from '../services/imap-client.js';
import { SmtpClient } from '../services/smtp-client.js';

const PORT = parseInt(process.env.IMAP_API_PORT || '4748', 10);

const config = loadConfig();
const imapClient = new ImapClient(config);

const smtpConfig = loadSmtpConfig();
const smtpClient = smtpConfig ? new SmtpClient(smtpConfig) : null;

const app = express();
app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────

app.get('/api/health', async (_req, res) => {
  let imapOk = false;
  try {
    await imapClient.ensureConnected();
    imapOk = true;
  } catch { /* ignore */ }

  res.json({
    status: 'ok',
    imap: imapOk ? 'connected' : 'disconnected',
    smtp: smtpClient ? 'configured' : 'not_configured',
  });
});

// ── Mailboxes ─────────────────────────────────────────────────────

app.get('/api/mailboxes', async (_req, res) => {
  try {
    const mailboxes = await imapClient.listMailboxes();
    res.json(mailboxes);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// ── Messages ──────────────────────────────────────────────────────

app.get('/api/messages', async (req, res) => {
  try {
    const mailbox = (req.query.mailbox as string) || 'INBOX';
    const result = await imapClient.listMessages(mailbox, {
      limit: intParam(req.query.limit, 20),
      offset: intParam(req.query.offset, 0),
      unseenOnly: req.query.unseen_only === 'true',
      since: req.query.since as string | undefined,
      before: req.query.before as string | undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.get('/api/messages/:uid', async (req, res) => {
  try {
    const mailbox = (req.query.mailbox as string) || 'INBOX';
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }

    const message = await imapClient.getMessage(mailbox, uid);
    if (!message) { res.status(404).json({ error: 'Message not found' }); return; }
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.get('/api/messages/:uid/raw', async (req, res) => {
  try {
    const mailbox = (req.query.mailbox as string) || 'INBOX';
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }

    const raw = await imapClient.getRawMessage(mailbox, uid);
    if (!raw) { res.status(404).json({ error: 'Message not found' }); return; }

    const filename = `message-${uid}.eml`;
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(raw.source);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.get('/api/messages/:uid/attachments/:part', async (req, res) => {
  try {
    const mailbox = (req.query.mailbox as string) || 'INBOX';
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }

    const attachment = await imapClient.getAttachment(mailbox, uid, req.params.part);
    const filename = attachment.filename || `attachment-${req.params.part}`;
    res.setHeader('Content-Type', attachment.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(attachment.size));
    res.send(attachment.content);
  } catch (err) {
    const msg = errMsg(err);
    if (msg.includes('not found') || msg.includes('not a valid attachment')) {
      res.status(404).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// ── Search ────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const mailbox = (req.query.mailbox as string) || 'INBOX';
    const messages = await imapClient.searchMessages(mailbox, {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      subject: req.query.subject as string | undefined,
      body: req.query.body as string | undefined,
      since: req.query.since as string | undefined,
      before: req.query.before as string | undefined,
      flagged: boolParam(req.query.flagged),
      unseen: boolParam(req.query.unseen),
      limit: intParam(req.query.limit, 50),
    });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// ── Message Actions ───────────────────────────────────────────────

app.post('/api/messages/:uid/move', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }
    const { mailbox = 'INBOX', destination } = req.body;
    if (!destination) { res.status(400).json({ error: 'Missing destination' }); return; }

    const moved = await imapClient.moveMessage(mailbox, uid, destination);
    res.json({ moved });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.post('/api/messages/:uid/mark', async (req, res) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }
    const { mailbox = 'INBOX', action } = req.body;
    if (!action || !['read', 'unread', 'flagged', 'unflagged'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Must be: read, unread, flagged, unflagged' });
      return;
    }

    const marked = await imapClient.markMessage(mailbox, uid, action);
    res.json({ marked });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.post('/api/messages/batch/move', async (req, res) => {
  try {
    const { mailbox = 'INBOX', uids, destination } = req.body;
    if (!Array.isArray(uids) || uids.length === 0) {
      res.status(400).json({ error: 'Missing or empty uids array' }); return;
    }
    if (!destination) { res.status(400).json({ error: 'Missing destination' }); return; }

    const moved = await imapClient.moveMessage(mailbox, uids, destination);
    res.json({ moved, count: uids.length });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.post('/api/messages/batch/mark', async (req, res) => {
  try {
    const { mailbox = 'INBOX', uids, action } = req.body;
    if (!Array.isArray(uids) || uids.length === 0) {
      res.status(400).json({ error: 'Missing or empty uids array' }); return;
    }
    if (!action || !['read', 'unread', 'flagged', 'unflagged'].includes(action)) {
      res.status(400).json({ error: 'Invalid action' }); return;
    }

    const marked = await imapClient.markMessage(mailbox, uids, action);
    res.json({ marked, count: uids.length });
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// ── Send (SMTP) ───────────────────────────────────────────────────

function requireSmtp(_req: express.Request, res: express.Response): boolean {
  if (!smtpClient) {
    res.status(503).json({ error: 'SMTP not configured', code: 'SMTP_NOT_CONFIGURED' });
    return false;
  }
  return true;
}

app.post('/api/send', async (req, res) => {
  if (!requireSmtp(req, res)) return;
  try {
    const { to, cc, bcc, subject, body, html } = req.body;
    if (!to || !subject || !body) {
      res.status(400).json({ error: 'Missing required fields: to, subject, body' }); return;
    }
    const result = await smtpClient!.send({ to, cc, bcc, subject, text: body, html });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.post('/api/messages/:uid/reply', async (req, res) => {
  if (!requireSmtp(req, res)) return;
  try {
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }
    const { mailbox = 'INBOX', body, reply_all = false } = req.body;
    if (!body) { res.status(400).json({ error: 'Missing body' }); return; }

    const original = await imapClient.getMessage(mailbox, uid);
    if (!original) { res.status(404).json({ error: 'Original message not found' }); return; }

    const result = await smtpClient!.reply(original, { body, replyAll: reply_all });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

app.post('/api/messages/:uid/forward', async (req, res) => {
  if (!requireSmtp(req, res)) return;
  try {
    const uid = parseInt(req.params.uid, 10);
    if (isNaN(uid)) { res.status(400).json({ error: 'Invalid UID' }); return; }
    const { mailbox = 'INBOX', to, body } = req.body;
    if (!to) { res.status(400).json({ error: 'Missing to' }); return; }

    const original = await imapClient.getMessage(mailbox, uid);
    if (!original) { res.status(404).json({ error: 'Original message not found' }); return; }

    const result = await smtpClient!.forward(original, { to, body });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errMsg(err) });
  }
});

// ── Helpers ───────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function intParam(val: unknown, fallback: number): number {
  if (typeof val === 'string') {
    const n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

function boolParam(val: unknown): boolean | undefined {
  if (val === 'true') return true;
  if (val === 'false') return false;
  return undefined;
}

// ── Start ─────────────────────────────────────────────────────────

async function shutdown() {
  await imapClient.disconnect();
  if (smtpClient) await smtpClient.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log(`mcp-imap HTTP server running at http://localhost:${PORT}`);
});
