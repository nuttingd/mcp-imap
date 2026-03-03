# mcp-imap

An MCP server that gives Claude full email access over IMAP and SMTP. Read, search, triage, compose, reply, and forward — all from the Claude Code CLI or any MCP-compatible client.

## Tools

| Tool | Description |
|------|-------------|
| `list_mailboxes` | List folders with message/unseen counts |
| `list_messages` | Paginated message summaries (subject, sender, date, flags) |
| `search_messages` | Search by from/to/subject/body/date/flagged/unseen |
| `get_message` | Full message content by UID (text, HTML, attachment metadata with part numbers) |
| `get_attachment` | Download attachment by IMAP part number — save to disk with `save_to`, or get inline (auto-saves large files to temp) |
| `save_as_eml` | Save the original raw RFC 2822 message to disk as an .eml file (byte-for-byte, signatures intact) |
| `move_message` | Move messages between folders (single UID or batch) |
| `mark_message` | Read/unread/flagged/unflagged (single UID or batch) |
| `send_message` | Compose and send a new email |
| `reply_message` | Reply with threading headers and quoted original |
| `forward_message` | Forward with original body |

Send/reply/forward require SMTP configuration. If SMTP env vars aren't set, those tools simply won't register — everything else still works.

## Setup

### Install

```bash
npm install
npm run build
```

### Configure

Add to your `.mcp.json` (e.g. in your project root or `~/.claude/`):

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/mcp-imap/dist/index.js"],
      "env": {
        "IMAP_HOST": "127.0.0.1",
        "IMAP_PORT": "993",
        "IMAP_USERNAME": "you@example.com",
        "IMAP_PASSWORD": "your-password",
        "IMAP_TLS": "true",
        "IMAP_REJECT_UNAUTHORIZED": "true",

        "SMTP_HOST": "127.0.0.1",
        "SMTP_PORT": "587",
        "SMTP_USERNAME": "you@example.com",
        "SMTP_PASSWORD": "your-password",
        "SMTP_TLS": "true",
        "SMTP_REJECT_UNAUTHORIZED": "true"
      }
    }
  }
}
```

### Environment variables

#### IMAP (required)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IMAP_HOST` | yes | — | IMAP server hostname |
| `IMAP_PORT` | no | `993` | IMAP port |
| `IMAP_USERNAME` | yes | — | IMAP username |
| `IMAP_PASSWORD` | yes | — | IMAP password |
| `IMAP_TLS` | no | `true` | Use implicit TLS (`false` for STARTTLS) |
| `IMAP_REJECT_UNAUTHORIZED` | no | `true` | Set `false` for self-signed certs |

#### SMTP (optional — enables send/reply/forward)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | yes | — | SMTP server hostname |
| `SMTP_PORT` | no | `587` | SMTP port |
| `SMTP_USERNAME` | yes | — | SMTP username |
| `SMTP_PASSWORD` | yes | — | SMTP password |
| `SMTP_TLS` | no | `true` | Use implicit TLS |
| `SMTP_REJECT_UNAUTHORIZED` | no | `true` | Set `false` for self-signed certs |

## Batch operations

`move_message` and `mark_message` accept a single UID or an array of UIDs:

```json
{ "uid": 8740 }
{ "uid": [8740, 8675, 8660] }
```

Arrays are sent as a single IMAP command — no looping.

## License

MIT
