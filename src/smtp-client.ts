import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { SmtpConfig, ParsedMessage } from './types.js';

export class SmtpClient {
  private transporter: Transporter | null = null;
  private config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  private ensureTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.tls,
      auth: {
        user: this.config.username,
        pass: this.config.password,
      },
      tls: { rejectUnauthorized: this.config.rejectUnauthorized },
    });

    return this.transporter;
  }

  async send(opts: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<{ messageId: string }> {
    const transport = this.ensureTransporter();
    const info = await transport.sendMail({
      from: this.config.username,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
    });
    return { messageId: info.messageId };
  }

  async reply(
    original: ParsedMessage,
    opts: { body: string; replyAll: boolean },
  ): Promise<{ messageId: string }> {
    const fromDisplay = original.from.name || original.from.address;
    const dateStr = original.date;
    const attribution = `On ${dateStr}, ${fromDisplay} wrote:`;
    const quotedText = original.text
      ? original.text.split('\n').map((line) => `> ${line}`).join('\n')
      : '';

    const text = `${opts.body}\n\n${attribution}\n${quotedText}`;

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    // Build references chain
    const references = original.references
      ? `${original.references} ${original.messageId}`
      : original.messageId;

    // Determine recipients
    const to = opts.replyAll
      ? [original.from.address, ...original.to.map((a) => a.address)].filter(
          (addr) => addr && addr !== this.config.username,
        ).join(', ') || original.from.address
      : original.from.address;

    const cc = opts.replyAll
      ? original.cc
          .map((a) => a.address)
          .filter((addr) => addr && addr !== this.config.username)
          .join(', ') || undefined
      : undefined;

    return this.send({
      to,
      cc,
      subject,
      text,
      inReplyTo: original.messageId,
      references,
    });
  }

  async forward(
    original: ParsedMessage,
    opts: { to: string; body?: string },
  ): Promise<{ messageId: string }> {
    const fromDisplay = original.from.name || original.from.address;
    const header = [
      '---------- Forwarded message ----------',
      `From: ${fromDisplay} <${original.from.address}>`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    const forwardedBody = original.text || '';
    const commentary = opts.body ? `${opts.body}\n\n` : '';
    const text = `${commentary}${header}${forwardedBody}`;

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    return this.send({ to: opts.to, subject, text });
  }

  async disconnect(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}
