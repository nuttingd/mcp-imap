import { ImapFlow } from 'imapflow';
import type { MessageStructureObject } from 'imapflow';
import { parseEmail } from './email-parser.js';
import type { ImapConfig, MailboxInfo, MessageSummary, ParsedMessage } from './types.js';

function hasAttachmentParts(structure: MessageStructureObject | undefined): boolean {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some(hasAttachmentParts);
  }
  return false;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private config: ImapConfig;
  private connecting: Promise<void> | null = null;

  constructor(config: ImapConfig) {
    this.config = config;
  }

  async ensureConnected(): Promise<ImapFlow> {
    if (this.client?.usable) {
      return this.client;
    }

    if (this.connecting) {
      await this.connecting;
      return this.client!;
    }

    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    return this.client!;
  }

  private async doConnect(): Promise<void> {
    if (this.client) {
      try { await this.client.logout(); } catch { /* ignore */ }
      this.client = null;
    }

    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      auth: {
        user: this.config.username,
        pass: this.config.password,
      },
      secure: this.config.tls,
      tls: { rejectUnauthorized: this.config.rejectUnauthorized },
      logger: false,
    });

    await this.client.connect();

    this.client.on('error', () => {
      // Swallow connection errors to prevent crashing the MCP process.
      // Tool calls will reconnect via ensureConnected().
      this.client = null;
    });

    this.client.on('close', () => {
      this.client = null;
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.logout(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const client = await this.ensureConnected();
    const mailboxes = await client.list({
      statusQuery: { messages: true, unseen: true },
    });
    return mailboxes.map((mb) => ({
      path: mb.path,
      name: mb.name,
      specialUse: mb.specialUse || null,
      totalMessages: mb.status?.messages ?? null,
      unseenMessages: mb.status?.unseen ?? null,
    }));
  }

  async listMessages(
    mailbox: string,
    options: {
      limit?: number;
      offset?: number;
      unseenOnly?: boolean;
      since?: string;
      before?: string;
    },
  ): Promise<{ messages: MessageSummary[]; total: number }> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const mb = client.mailbox;
      const total = mb ? mb.exists : 0;

      if (total === 0) return { messages: [], total: 0 };

      const criteria: Record<string, unknown> = {};
      if (options.unseenOnly) criteria.seen = false;
      if (options.since) criteria.since = new Date(options.since);
      if (options.before) criteria.before = new Date(options.before);

      const hasSearch = Object.keys(criteria).length > 0;
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;

      let fetchRange: string;

      if (hasSearch) {
        const result = await client.search(criteria, { uid: false });
        const seqNos = Array.isArray(result) ? result : [];
        if (seqNos.length === 0) return { messages: [], total };

        const sorted = seqNos.sort((a, b) => b - a);
        const sliced = sorted.slice(offset, offset + limit);
        if (sliced.length === 0) return { messages: [], total };
        fetchRange = sliced.join(',');
      } else {
        const end = Math.max(1, total - offset);
        const start = Math.max(1, end - limit + 1);
        if (start > end) return { messages: [], total };
        fetchRange = `${start}:${end}`;
      }

      const messages: MessageSummary[] = [];
      for await (const msg of client.fetch(
        fetchRange,
        { uid: true, flags: true, envelope: true, bodyStructure: true },
        { uid: false },
      )) {
        messages.push({
          uid: msg.uid,
          messageId: msg.envelope?.messageId ?? '',
          flags: msg.flags ? [...msg.flags] : [],
          subject: msg.envelope?.subject ?? '(no subject)',
          from: {
            name: msg.envelope?.from?.[0]?.name ?? '',
            address: msg.envelope?.from?.[0]?.address ?? '',
          },
          date: msg.envelope?.date
            ? new Date(msg.envelope.date).toISOString()
            : '',
          hasAttachments: hasAttachmentParts(msg.bodyStructure),
        });
      }

      messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return { messages, total };
    } finally {
      lock.release();
    }
  }

  async searchMessages(
    mailbox: string,
    criteria: {
      from?: string;
      to?: string;
      subject?: string;
      body?: string;
      since?: string;
      before?: string;
      flagged?: boolean;
      unseen?: boolean;
      limit?: number;
    },
  ): Promise<MessageSummary[]> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const searchObj: Record<string, unknown> = {};
      if (criteria.from) searchObj.from = criteria.from;
      if (criteria.to) searchObj.to = criteria.to;
      if (criteria.subject) searchObj.subject = criteria.subject;
      if (criteria.body) searchObj.body = criteria.body;
      if (criteria.since) searchObj.since = new Date(criteria.since);
      if (criteria.before) searchObj.before = new Date(criteria.before);
      if (criteria.flagged !== undefined) searchObj.flagged = criteria.flagged;
      if (criteria.unseen !== undefined) searchObj.seen = !criteria.unseen;

      const result = await client.search(searchObj, { uid: false });
      const seqNos = Array.isArray(result) ? result : [];
      if (seqNos.length === 0) return [];

      const limit = criteria.limit ?? 50;
      const sorted = seqNos.sort((a, b) => b - a).slice(0, limit);

      const messages: MessageSummary[] = [];
      for await (const msg of client.fetch(
        sorted.join(','),
        { uid: true, flags: true, envelope: true, bodyStructure: true },
        { uid: false },
      )) {
        messages.push({
          uid: msg.uid,
          messageId: msg.envelope?.messageId ?? '',
          flags: msg.flags ? [...msg.flags] : [],
          subject: msg.envelope?.subject ?? '(no subject)',
          from: {
            name: msg.envelope?.from?.[0]?.name ?? '',
            address: msg.envelope?.from?.[0]?.address ?? '',
          },
          date: msg.envelope?.date
            ? new Date(msg.envelope.date).toISOString()
            : '',
          hasAttachments: hasAttachmentParts(msg.bodyStructure),
        });
      }

      messages.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return messages;
    } finally {
      lock.release();
    }
  }

  async getMessage(mailbox: string, uid: number): Promise<ParsedMessage | null> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { source: true, uid: true },
        { uid: true },
      );
      if (!msg || !msg.source) return null;
      return parseEmail(msg.source, msg.uid);
    } finally {
      lock.release();
    }
  }

  async moveMessage(mailbox: string, uid: number | number[], destination: string): Promise<boolean> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const range = Array.isArray(uid) ? uid.join(',') : String(uid);
      const result = await client.messageMove(range, destination, { uid: true });
      return result !== false;
    } finally {
      lock.release();
    }
  }

  async markMessage(
    mailbox: string,
    uid: number | number[],
    action: 'read' | 'unread' | 'flagged' | 'unflagged',
  ): Promise<boolean> {
    const client = await this.ensureConnected();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const range = Array.isArray(uid) ? uid.join(',') : String(uid);
      const opts = { uid: true };
      switch (action) {
        case 'read':
          return await client.messageFlagsAdd(range, ['\\Seen'], opts);
        case 'unread':
          return await client.messageFlagsRemove(range, ['\\Seen'], opts);
        case 'flagged':
          return await client.messageFlagsAdd(range, ['\\Flagged'], opts);
        case 'unflagged':
          return await client.messageFlagsRemove(range, ['\\Flagged'], opts);
      }
    } finally {
      lock.release();
    }
  }
}
