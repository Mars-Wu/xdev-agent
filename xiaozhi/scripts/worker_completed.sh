#!/bin/bash
# scripts/worker_completed.sh
# Worker完成时通知小智

WORKER_ID="$1"
XIAOZHI_HOST="${XIAOZHI_HOST:-localhost}"
XIAOZHI_PORT="${XIAOZHI_PORT:-8081}"

# 从stdin读取hook数据
INPUT=$(cat)

# 检查jq是否可用
if ! command -v jq &> /dev/null; then
  echo "jq not found, skipping notification" >&2
  exit 0
fi

# 提取关键信息
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
RESULT=$(echo "$INPUT" | jq -r '.result // empty' 2>/dev/null)
COST=$(echo "$INPUT" | jq -r '.cost_usd // 0' 2>/dev/null)
DURATION=$(echo "$INPUT" | jq -r '.duration_ms // 0' 2>/dev/null)

if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$SESSION_ID"
fi

# 确定状态
if echo "$RESULT" | grep -qi "error\|failed"; then
  STATUS="failed"
else
  STATUS="success"
fi

# 发送完成通知
curl -s -X POST "http://${XIAOZHI_HOST}:${XIAOZHI_PORT}/internal/worker/complete" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"status\": \"$STATUS\",
    \"result\": $(echo "$RESULT" | jq -R .),
    \"cost\": $COST,
    \"duration\": $DURATION,
    \"timestamp\": \"$(date -Iseconds)\"
  }" > /dev/null 2>&1

# 保存完整结果
XIAOZHI_HOME="${XIAOZHI_HOME:-/var/lib/xiaozhi}"
RESULT_FILE="${XIAOZHI_HOME}/workers/${WORKER_ID}/result.json"
if [ -d "$(dirname "$RESULT_FILE")" ]; then
  echo "$INPUT" > "$RESULT_FILE"
fi
