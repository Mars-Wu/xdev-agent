#!/bin/bash
# scripts/worker_completed.sh
# Notify Xdev when a worker completes

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8081}"

# Read hook payload from stdin
INPUT=$(cat)

# jq is required to parse hook payloads
if ! command -v jq &> /dev/null; then
  echo "jq not found, skipping notification" >&2
  exit 0
fi

resolve_xdev_home() {
  if [ -n "${XDEV_HOME:-}" ]; then
    echo "$XDEV_HOME"
  elif [ "$(id -un)" = "xdev" ]; then
    echo "${HOME:-/var/lib/xdev}"
  else
    echo "${HOME}/.xdev"
  fi
}

# Extract relevant fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
RESULT=$(echo "$INPUT" | jq -r '.result // empty' 2>/dev/null)
COST=$(echo "$INPUT" | jq -r '.cost_usd // 0' 2>/dev/null)
DURATION=$(echo "$INPUT" | jq -r '.duration_ms // 0' 2>/dev/null)

if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$SESSION_ID"
fi

# Derive completion status
if echo "$RESULT" | grep -qi "error\|failed"; then
  STATUS="failed"
else
  STATUS="success"
fi

# Send the completion event to Xdev
curl -s -X POST "http://${XDEV_HOST}:${XDEV_PORT}/internal/worker/complete" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"status\": \"$STATUS\",
    \"result\": $(echo "$RESULT" | jq -R .),
    \"cost\": $COST,
    \"duration\": $DURATION,
    \"timestamp\": \"$(date -Iseconds)\"
  }" > /dev/null 2>&1

# Persist the full result when the runtime worker directory exists
XDEV_HOME="$(resolve_xdev_home)"
RESULT_FILE="${XDEV_HOME}/workers/${WORKER_ID}/result.json"
if [ -d "$(dirname "$RESULT_FILE")" ]; then
  echo "$INPUT" > "$RESULT_FILE"
fi
