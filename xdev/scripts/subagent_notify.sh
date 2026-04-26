#!/bin/bash
# scripts/subagent_notify.sh
# Notify Xdev when a subagent finishes

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8081}"

INPUT=$(cat)

# jq is required to parse hook payloads
if ! command -v jq &> /dev/null; then
  echo "jq not found, skipping notification" >&2
  exit 0
fi

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
PARENT_ID=$(echo "$INPUT" | jq -r '.parent_session_id // empty' 2>/dev/null)
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.subagent_type // "unknown"' 2>/dev/null)
RESULT=$(echo "$INPUT" | jq -r '.result // empty' 2>/dev/null)

if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$PARENT_ID"
fi

# Record subagent activity
curl -s -X POST "http://${XDEV_HOST}:${XDEV_PORT}/internal/worker/subagent" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"subagent_id\": \"$SESSION_ID\",
    \"subagent_type\": \"$SUBAGENT_TYPE\",
    \"result\": $(echo "$RESULT" | head -c 500 | jq -R .),
    \"timestamp\": \"$(date -Iseconds)\"
  }" > /dev/null 2>&1
