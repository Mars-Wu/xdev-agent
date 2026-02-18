#!/bin/bash
# scripts/subagent_notify.sh
# 子代理完成时通知

WORKER_ID="$1"
XIAOZHI_HOST="${XIAOZHI_HOST:-localhost}"
XIAOZHI_PORT="${XIAOZHI_PORT:-8081}"

INPUT=$(cat)

# 检查jq是否可用
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

# 记录子代理活动
curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/internal/worker/subagent" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"subagent_id\": \"$SESSION_ID\",
    \"subagent_type\": \"$SUBAGENT_TYPE\",
    \"result\": $(echo "$RESULT" | head -c 500 | jq -R .),
    \"timestamp\": \"$(date -Iseconds)\"
  }" > /dev/null 2>&1
