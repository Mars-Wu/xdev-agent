// src/context/micro-compact.test.ts

import { describe, it, expect } from 'vitest';
import { microCompactMessages } from './micro-compact';
import type { ContentBlock } from '../core/message-history';

type Msg = { role: string; content: string | ContentBlock[] };

function toolResultMsg(id: string, content: string): Msg {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }],
  };
}

function textMsg(role: string, text: string): Msg {
  return { role, content: text };
}

describe('microCompactMessages', () => {
  it('无 tool_result 时原样返回（无克隆开销）', () => {
    const msgs: Msg[] = [textMsg('user', 'hello'), textMsg('assistant', 'hi')];
    const result = microCompactMessages(msgs);
    expect(result).toBe(msgs); // 同一引用
  });

  it('不修改原始消息数组', () => {
    const original = 'A'.repeat(100);
    const msgs: Msg[] = [toolResultMsg('1', original)];
    microCompactMessages(msgs);
    // 原始消息不变
    const block = (msgs[0].content as ContentBlock[])[0];
    expect(block.content).toBe(original);
  });

  it('最近 KEEP_RECENT(3) 条保持完整（内容不变）', () => {
    const msgs: Msg[] = [
      toolResultMsg('1', 'result-1'),
      toolResultMsg('2', 'result-2'),
      toolResultMsg('3', 'result-3'),
    ];
    const result = microCompactMessages(msgs);
    for (let i = 0; i < 3; i++) {
      const block = (result[i].content as ContentBlock[])[0];
      expect(block.content).toBe(`result-${i + 1}`);
    }
  });

  it('超过 3 条时，旧条目被替换为 [omitted N chars]', () => {
    const msgs: Msg[] = [
      toolResultMsg('1', 'A'.repeat(100)), // 将被 omit
      toolResultMsg('2', 'result-2'),
      toolResultMsg('3', 'result-3'),
      toolResultMsg('4', 'result-4'),
    ];
    const result = microCompactMessages(msgs);
    const first = (result[0].content as ContentBlock[])[0];
    expect(first.content).toBe('[omitted 100 chars]');

    // 最近 3 条不变
    expect((result[1].content as ContentBlock[])[0].content).toBe('result-2');
    expect((result[2].content as ContentBlock[])[0].content).toBe('result-3');
    expect((result[3].content as ContentBlock[])[0].content).toBe('result-4');
  });

  it('50 字符以内的旧结果不被 omit（太短没意义）', () => {
    const msgs: Msg[] = [
      toolResultMsg('1', 'short'),
      toolResultMsg('2', 'r2'),
      toolResultMsg('3', 'r3'),
      toolResultMsg('4', 'r4'),
    ];
    const result = microCompactMessages(msgs);
    const first = (result[0].content as ContentBlock[])[0];
    // <= 50 chars: not omitted
    expect(first.content).toBe('short');
  });

  it('最近条目超过 MAX_RESULT_LEN(4000) 时做首尾截断', () => {
    const longContent = 'X'.repeat(5000);
    const msgs: Msg[] = [toolResultMsg('1', longContent)];
    const result = microCompactMessages(msgs);
    const block = (result[0].content as ContentBlock[])[0];
    expect(typeof block.content).toBe('string');
    expect((block.content as string).length).toBeLessThan(longContent.length);
    expect(block.content as string).toContain('[truncated, original 5000 chars]');
  });

  it('多消息中含多个 tool_result 块时正确识别', () => {
    const msgs: Msg[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: '1', content: 'X'.repeat(100), is_error: false },
          { type: 'tool_result', tool_use_id: '2', content: 'Y'.repeat(100), is_error: false },
        ],
      },
      toolResultMsg('3', 'r3'),
      toolResultMsg('4', 'r4'),
    ];
    const result = microCompactMessages(msgs);
    // refs = [1, 2, 3, 4], toOmit = [1]
    const blocks = result[0].content as ContentBlock[];
    expect(blocks[0].content).toBe('[omitted 100 chars]');
    expect(blocks[1].content).toBe('Y'.repeat(100)); // 保留（最近3条中）
  });
});
