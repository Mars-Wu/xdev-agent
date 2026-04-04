// src/context/micro-compact.ts
// Micro-compact：每轮 Agent Loop 开始前截断旧 tool_result，避免上下文无限膨胀
//
// 策略：
//   - 保留最近 KEEP_RECENT 条 tool_result 的完整内容
//   - 更早的 tool_result 内容替换为 "[omitted N chars]"
//   - 每条 tool_result 超过 MAX_LEN 时截断（首尾保留）

import type { ContentBlock } from '../core/message-history';

/** 保留最近几条 tool_result 完整内容 */
const KEEP_RECENT = 3;
/** 单条 tool_result 最大长度（字符） */
const MAX_RESULT_LEN = 4000;

type AnyMessage = { role: string; content: string | ContentBlock[] };

/**
 * 对 messages 数组做 micro-compact，返回用于 LLM 调用的副本。
 * 不修改原始 historyManager 中的数据。
 */
export function microCompactMessages(messages: AnyMessage[]): AnyMessage[] {
  // 收集所有 tool_result 块的位置（按出现顺序）
  const refs: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j] as ContentBlock;
      if (block.type === 'tool_result') {
        refs.push({ msgIdx: i, blockIdx: j });
      }
    }
  }

  // 没有工具结果，直接返回原数据（无需克隆，省开销）
  if (refs.length === 0) return messages;

  // 浅克隆消息数组 + 深克隆含 tool_result 的消息
  const cloned: AnyMessage[] = messages.map(m => ({ ...m }));
  const touchedMsgIdxs = new Set(refs.map(r => r.msgIdx));
  for (const idx of touchedMsgIdxs) {
    cloned[idx] = {
      ...cloned[idx],
      content: [...(messages[idx].content as ContentBlock[])],
    };
  }

  // 旧 tool_result（非最近 KEEP_RECENT 条）→ 替换为占位符
  const toOmit = refs.slice(0, -KEEP_RECENT);
  for (const { msgIdx, blockIdx } of toOmit) {
    const block = { ...(cloned[msgIdx].content as ContentBlock[])[blockIdx] };
    if (typeof block.content === 'string' && block.content.length > 50) {
      const originalLen = block.content.length;
      block.content = `[omitted ${originalLen} chars]`;
    }
    (cloned[msgIdx].content as ContentBlock[])[blockIdx] = block;
  }

  // 最近 KEEP_RECENT 条：超出 MAX_RESULT_LEN 时首尾截断
  const toTruncate = refs.slice(-KEEP_RECENT);
  for (const { msgIdx, blockIdx } of toTruncate) {
    const block = { ...(cloned[msgIdx].content as ContentBlock[])[blockIdx] };
    if (typeof block.content === 'string' && block.content.length > MAX_RESULT_LEN) {
      const half = MAX_RESULT_LEN / 2;
      block.content =
        block.content.slice(0, half) +
        `\n...[truncated, original ${block.content.length} chars]...\n` +
        block.content.slice(-MAX_RESULT_LEN / 4);
    }
    (cloned[msgIdx].content as ContentBlock[])[blockIdx] = block;
  }

  return cloned;
}
