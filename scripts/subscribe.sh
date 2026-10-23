#!/usr/bin/env bash
# Subscribes the Instagram account to the `messages` webhook field (plan section 5 step 8).
# Reads the token from the first argument or from $IG_ACCESS_TOKEN (copy it from the n8n `config` Data Table).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }
token="${1:-${IG_ACCESS_TOKEN:-}}"
[ -n "$token" ] || { echo "usage: $0 <access token>   (or set IG_ACCESS_TOKEN)" >&2; exit 2; }
curl -sS -X POST "${IG_GRAPH_BASE:-https://graph.instagram.com}/${IG_GRAPH_VERSION:-v26.0}/me/subscribed_apps" \
  --data-urlencode "subscribed_fields=messages" -H "Authorization: Bearer $token"
echo
echo "Check: curl -H 'Authorization: Bearer <token>' ${IG_GRAPH_BASE:-https://graph.instagram.com}/${IG_GRAPH_VERSION:-v26.0}/me/subscribed_apps"
