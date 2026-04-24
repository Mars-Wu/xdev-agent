#!/bin/bash
# scripts/notify_xdev.sh
# Worker向艾克斯发送进度通知

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8081}"

# 从stdin读取hook数据
INPUT=$(cat)

# 提取关键信息
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
NOTIFICATION=$(echo "$INPUT" | jq -r '.notification // empty' 2>/dev/null)
REASON=$(echo "$INPUT" | jq -r '.reason // "progress"' 2>/dev/null)

# 如果没有提供worker_id，从session_id提取
if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$SESSION_ID"
fi

# 检查jq是否可用
if ! command -v jq &> /dev/null; then
  echo "jq not found, skipping notification" >&2
  exit 0
fi

# 发送到艾克斯
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

# 同时写入进度文件（备用）
XDEV_HOME="${XDEV_HOME:-/var/lib/xdev}"
PROGRESS_FILE="${XDEV_HOME}/workers/${WORKER_ID}/progress.json"
if [ -d "$(dirname "$PROGRESS_FILE")" ]; then
  echo "$INPUT" > "$PROGRESS_FILE"
fi
