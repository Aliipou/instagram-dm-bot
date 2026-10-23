#!/usr/bin/env bash
# Manual long-lived token refresh. Prints the new token and expires_in; paste the token into the
# n8n `config` Data Table (key ig_access_token) and set ig_token_expires_at to now + expires_in.
# The token must be at least 24 hours old and not expired.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
token="${1:-${IG_ACCESS_TOKEN:-}}"
[ -n "$token" ] || { echo "usage: $0 <current access token>   (or set IG_ACCESS_TOKEN)" >&2; exit 2; }
curl -sS -G "${IG_GRAPH_BASE:-https://graph.instagram.com}/refresh_access_token" \
  --data-urlencode "grant_type=ig_refresh_token" --data-urlencode "access_token=$token"
echo
