#!/usr/bin/env bash
# Integration test for mcp-imap HTTP API
# Requires IMAP env vars to be set. Optionally SMTP env vars for send tests.
#
# Usage: ./test/integration.sh

set -euo pipefail

BASE="${IMAP_API_URL:-http://localhost:4748}"
PASS=0
FAIL=0
SKIP=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }

check() {
  local desc="$1" url="$2" expected_status="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  if [ "$status" = "$expected_status" ]; then
    green "  PASS: $desc (HTTP $status)"
    ((PASS++))
  else
    red "  FAIL: $desc — expected $expected_status, got $status"
    ((FAIL++))
  fi
}

check_post() {
  local desc="$1" url="$2" body="$3" expected_status="${4:-200}"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$body" "$url")
  if [ "$status" = "$expected_status" ]; then
    green "  PASS: $desc (HTTP $status)"
    ((PASS++))
  else
    red "  FAIL: $desc — expected $expected_status, got $status"
    ((FAIL++))
  fi
}

echo "=== mcp-imap HTTP API Integration Tests ==="
echo "Base: $BASE"
echo ""

echo "--- Health ---"
check "GET /api/health" "$BASE/api/health"

echo ""
echo "--- Mailboxes ---"
check "GET /api/mailboxes" "$BASE/api/mailboxes"

echo ""
echo "--- Messages ---"
check "GET /api/messages (INBOX)" "$BASE/api/messages?mailbox=INBOX&limit=5"
check "GET /api/messages (with offset)" "$BASE/api/messages?mailbox=INBOX&limit=5&offset=0"
check "GET /api/messages (unseen only)" "$BASE/api/messages?mailbox=INBOX&limit=5&unseen_only=true"

# Grab first UID for detailed tests
FIRST_UID=$(curl -s "$BASE/api/messages?mailbox=INBOX&limit=1" | python3 -c "import sys,json; msgs=json.load(sys.stdin).get('messages',[]); print(msgs[0]['uid'] if msgs else '')" 2>/dev/null || echo "")

if [ -n "$FIRST_UID" ]; then
  echo ""
  echo "--- Single Message (UID=$FIRST_UID) ---"
  check "GET /api/messages/:uid" "$BASE/api/messages/$FIRST_UID?mailbox=INBOX"
  check "GET /api/messages/:uid/raw" "$BASE/api/messages/$FIRST_UID/raw?mailbox=INBOX"
  check "GET /api/messages/:uid (invalid)" "$BASE/api/messages/999999999?mailbox=INBOX" 404
else
  yellow "  SKIP: No messages in INBOX to test individual message endpoints"
  ((SKIP+=3))
fi

echo ""
echo "--- Search ---"
check "GET /api/search (empty)" "$BASE/api/search?mailbox=INBOX&limit=5"
check "GET /api/search (with from)" "$BASE/api/search?mailbox=INBOX&from=test&limit=5"

echo ""
echo "--- Message Actions ---"
if [ -n "$FIRST_UID" ]; then
  check_post "POST mark read" "$BASE/api/messages/$FIRST_UID/mark" '{"mailbox":"INBOX","action":"read"}'
  check_post "POST mark unread" "$BASE/api/messages/$FIRST_UID/mark" '{"mailbox":"INBOX","action":"unread"}'
else
  yellow "  SKIP: No messages to test actions"
  ((SKIP+=2))
fi

check_post "POST mark (bad action)" "$BASE/api/messages/1/mark" '{"mailbox":"INBOX","action":"invalid"}' 400
check_post "POST mark (bad uid)" "$BASE/api/messages/abc/mark" '{"mailbox":"INBOX","action":"read"}' 400

echo ""
echo "--- SMTP Endpoints ---"
# These should return 503 if SMTP not configured, 400 if missing fields
check_post "POST /api/send (missing fields)" "$BASE/api/send" '{}' ""
# Accept either 400 (missing fields) or 503 (smtp not configured)
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/send")
if [ "$STATUS" = "400" ] || [ "$STATUS" = "503" ]; then
  green "  PASS: POST /api/send rejects properly (HTTP $STATUS)"
  ((PASS++))
else
  red "  FAIL: POST /api/send — expected 400 or 503, got $STATUS"
  ((FAIL++))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
