// src/expert/token-counter.test.ts
// Token 计数器单元测试

import { describe, it, expect } from 'vitest';
import { TokenCounter, estimateTokens, estimateMessagesTokens } from './token-counter';

describe('TokenCounter', () => {
  const counter = new TokenCounter();

  describe('estimateText', () => {
    it('应该返回 0 对于空字符串', () => {
      expect(counter.estimateText('')).toBe(0);
    });

    it('应该正确估算英文文本', () => {
      const text = 'Hello, this is a test message.';
      const tokens = counter.estimateText(text);
      // 英文大约 4 字符/token
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(text.length);
    });

    it('应该正确估算中文文本', () => {
      const text = '这是一段中文测试文本';
      const tokens = counter.estimateText(text);
      // 中文大约 1.5 字符/token
      expect(tokens).toBeGreaterThan(0);
    });

    it('应该正确估算中英文混合文本', () => {
      const text = 'Hello 世界，this 是 mixed 文本';
      const tokens = counter.estimateText(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it('应该正确估算代码', () => {
      const code = 'function add(a, b) { return a + b; }';
      const tokens = counter.estimateText(code);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('estimateMessage', () => {
    it('应该正确估算单条消息', () => {
      const message = {
        role: 'user' as const,
        content: 'Hello, world!',
      };
      const tokens = counter.estimateMessage(message);
      expect(tokens).toBeGreaterThan(0);
      // 应该包含格式开销
      expect(tokens).toBeGreaterThan(counter.estimateText(message.content));
    });

    it('应该包含 name 字段的 token', () => {
      const messageWith = {
        role: 'user' as const,
        content: 'Hello',
        name: 'test-user',
      };
      const messageWithout = {
        role: 'user' as const,
        content: 'Hello',
      };

      const tokensWith = counter.estimateMessage(messageWith);
      const tokensWithout = counter.estimateMessage(messageWithout);

      expect(tokensWith).toBeGreaterThan(tokensWithout);
    });
  });

  describe('estimateMessages', () => {
    it('应该正确估算消息数组', () => {
      const messages = [
        { role: 'system' as const, content: 'You are an assistant' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];

      const result = counter.estimateMessages(messages);

      expect(result.total).toBeGreaterThan(0);
      expect(result.breakdown.system).toBeGreaterThan(0);
      expect(result.breakdown.user).toBeGreaterThan(0);
      expect(result.breakdown.assistant).toBeGreaterThan(0);
      expect(result.estimated).toBe(true);
    });

    it('应该返回 0 对于空数组', () => {
      const result = counter.estimateMessages([]);
      expect(result.total).toBe(3); // 只有对话格式开销
    });
  });

  describe('calculateRemaining', () => {
    it('应该正确计算剩余 token', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello' },
      ];
      const maxTokens = 10000;

      const remaining = counter.calculateRemaining(messages, maxTokens);

      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(maxTokens);
    });

    it('应该考虑系统提示词', () => {
      const messages = [{ role: 'user' as const, content: 'Hello' }];
      const systemPrompt = 'You are a helpful assistant.';

      const withSystem = counter.calculateRemaining(messages, 10000, systemPrompt);
      const withoutSystem = counter.calculateRemaining(messages, 10000);

      expect(withSystem).toBeLessThan(withoutSystem);
    });
  });

  describe('needsCompaction', () => {
    it('应该在剩余空间不足时返回 true', () => {
      const messages = [
        { role: 'user' as const, content: 'A'.repeat(50000) },
        { role: 'assistant' as const, content: 'B'.repeat(50000) },
      ];

      const needs = counter.needsCompaction(messages, 10000);
      expect(needs).toBe(true);
    });

    it('应该在剩余空间充足时返回 false', () => {
      const messages = [{ role: 'user' as const, content: 'Hello' }];

      const needs = counter.needsCompaction(messages, 100000);
      expect(needs).toBe(false);
    });
  });
});

describe('快捷函数', () => {
  it('estimateTokens 应该工作', () => {
    const tokens = estimateTokens('Hello world');
    expect(tokens).toBeGreaterThan(0);
  });

  it('estimateMessagesTokens 应该工作', () => {
    const tokens = estimateMessagesTokens([
      { role: 'user', content: 'Hello' },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });
});
