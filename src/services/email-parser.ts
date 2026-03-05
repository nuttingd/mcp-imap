import PostalMime from 'postal-mime';
import type { ParsedMessage, ParsedAddress, StructurePart } from '../shared/types.js';

function parseAddress(addr: { name?: string; address?: string } | undefined): ParsedAddress {
  return {
    name: addr?.name ?? '',
    address: addr?.address ?? '',
  };
}

function parseAddressList(addrs: { name?: string; address?: string }[] | undefined): ParsedAddress[] {
  if (!addrs || addrs.length === 0) return [];
  return addrs.map(parseAddress);
}

export async function parseEmail(
  raw: Buffer,
  uid: number,
  structureParts?: StructurePart[],
): Promise<ParsedMessage> {
  const parser = new PostalMime();
  const email = await parser.parse(raw);

  // When bodyStructure parts are available, use them — they carry authoritative IMAP part numbers.
  // Fall back to postal-mime metadata when structure parts aren't provided.
  const attachments = structureParts && structureParts.length > 0
    ? structureParts.map((sp) => ({
        part: sp.part,
        filename: sp.filename,
        contentType: sp.contentType,
        size: sp.size,
      }))
    : (email.attachments || []).map((att, i) => ({
        part: String(i + 1),
        filename: att.filename || null,
        contentType: att.mimeType || 'application/octet-stream',
        size: att.content instanceof ArrayBuffer ? att.content.byteLength : 0,
      }));

  return {
    uid,
    messageId: email.messageId || '',
    from: parseAddress(email.from),
    to: parseAddressList(email.to),
    cc: parseAddressList(email.cc),
    subject: email.subject || '',
    date: email.date ? new Date(email.date).toISOString() : new Date().toISOString(),
    inReplyTo: (email as any).inReplyTo || null,
    references: (email as any).references || null,
    text: email.text || null,
    html: email.html || null,
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    attachments,
  };
}
