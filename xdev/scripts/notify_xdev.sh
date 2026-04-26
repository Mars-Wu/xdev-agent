#!/bin/bash
# scripts/notify_xdev.sh
# Send worker progress notifications to Xdev

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8081}"

# Read hook payload from stdin
INPUT=$(cat)

# Extract relevant fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
NOTIFICATION=$(echo "$INPUT" | jq -r '.notification // empty' 2>/dev/null)
REASON=$(echo "$INPUT" | jq -r '.reason // "progress"' 2>/dev/null)

# Fall back to the session identifier when no worker id was provided
if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$SESSION_ID"
fi

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

# Send the notification to Xdev
if [ -n "$WORKER_ID" ] && [ -n "$NOTIFICATION" ]; then
  curl -s -X POST "http://${XDEV_HOST}:${XDEV_PORT}/internal/worker/notify" \
    -H "Content-Type: application/json" \
    -d "{
      \"worker_id\": \"$WORKER_ID\",
      \"type\": \"$REASON\",
      \"message\": $(echo "$NOTIFICATION" | jq -R .),
      \"timestamp\": \"$(date -Iseconds)\"
    }" > /dev/null 2>&1
fi

# Also write a local progress file when the runtime worker directory exists
XDEV_HOME="$(resolve_xdev_home)"
PROGRESS_FILE="${XDEV_HOME}/workers/${WORKER_ID}/progress.json"
if [ -d "$(dirname "$PROGRESS_FILE")" ]; then
  echo "$INPUT" > "$PROGRESS_FILE"
fi
