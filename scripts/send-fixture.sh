#!/usr/bin/env bash
# Usage: scripts/send-fixture.sh <fixture.json> [--fresh-mid] [--secret <secret>] [--url <webhook url>]
# Signs the fixture body with IG_APP_SECRET (HMAC-SHA256, header X-Hub-Signature-256) and POSTs it.
# Placeholders in fixtures: __ACCOUNT_ID__ (IG_ACCOUNT_ID), __NOW_MS__, __NOW_S__, __MID__
#   (__MID__ becomes "mid.fixture", or a random id with --fresh-mid).
# Use --secret wrong to test a bad signature (test 15).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

file="${1:?fixture file required}"; shift || true
fresh=0; secret="${IG_APP_SECRET:-}"; url="${WEBHOOK_URL:-http://localhost:5678/}webhook/ig"
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh-mid) fresh=1 ;;
    --secret) secret="$2"; shift ;;
    --url) url="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$secret" ] || { echo "IG_APP_SECRET not set (use .env or --secret)" >&2; exit 2; }

now_ms=$(( $(date +%s) * 1000 )); now_s=$(date +%s)
mid="mid.fixture"
[ "$fresh" = 1 ] && mid="mid.$(openssl rand -hex 8)"

# Work on a temp file so the exact bytes that are signed are the bytes that are sent (UTF-8 safe, also on Windows).
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e "s/__ACCOUNT_ID__/${IG_ACCOUNT_ID:-17841400000000000}/g" \
    -e "s/__NOW_MS__/$now_ms/g" -e "s/__NOW_S__/$now_s/g" -e "s/__MID__/$mid/g" "$file" \
  | tr -d '\r\n' > "$tmp"
sig=$(openssl dgst -sha256 -hmac "$secret" -hex < "$tmp" | sed 's/^.* //')

echo "POST $url"
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST "$url" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$sig" \
  --data-binary "@$tmp"
