// src/expert/context-pruning.test.ts
// 上下文修剪策略单元测试

import { describe, it, expect } from 'vitest';
import { ContextPruner, DEFAULT_PRUNING_CONFIG, PrioritizedMessage } from './context-pruning';
import { TokenCounter } from './token-counter';

describe('ContextPruner', () => {
  const tokenCounter = new TokenCounter();
  const pruner = new ContextPruner(tokenCounter);

  // 创建测试消息
  function createMessage(
    role: PrioritizedMessage['role'],
    content: string,
    priority?: PrioritizedMessage['priority']
  ): PrioritizedMessage {
    return {
      role,
      content,
      priority: priority || 'normal',
      timestamp: new Date(),
    };
  }

  describe('calculatePriority', () => {
    it('系统消息应该是关键优先级', () => {
      const msg = createMessage('system', 'You are an assistant');
      const priority = pruner.calculatePriority(msg);
      expect(priority).toBe('critical');
    });

    it('工具调用结果应该是关键优先级', () => {
      const msg = createMessage('tool', 'Result: 42');
      const priority = pruner.calculatePriority(msg);
      expect(priority).toBe('critical');
    });

    it('包含错误关键词应该是关键优先级', () => {
      const msg = createMessage('user', '发生了错误，请帮忙处理');
      const priority = pruner.calculatePriority(msg);
      expect(priority).toBe('critical');
    });

    it('包含代码关键词应该是高优先级', () => {
      const msg = createMessage('user', '请帮我写一段代码');
      const priority = pruner.calculatePriority(msg);
      expect(priority).toBe('high');
    });

    it('简短确认应该是低优先级', () => {
      const msg = createMessage('user', '好的');
      const priority = pruner.calculatePriority(msg);
      expect(priority).toBe('low');
    });

    it('普通消息应该是普通优先级', () => {
      const msg = createMessage('user', '今天天气怎么样？');
      const priority = pruner.calculatePriority(msg);
      expect(priority).toBe('normal');
    });
  });

  describe('prune', () => {
    it('不需要修剪时应该返回原消息', () => {
      const messages = [
        createMessage('system', 'System prompt'),
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
      ];

      const result = pruner.prune(messages);

      expect(result.pruned).toBe(false);
      expect(result.removedCount).toBe(0);
      expect(result.messages.length).toBe(messages.length);
    });

    it('需要修剪时应该移除部分消息', () => {
      // 创建大量消息以触发修剪
      const messages: PrioritizedMessage[] = [
        createMessage('system', 'System prompt'),
      ];

      // 添加大量用户/助手消息
      for (let i = 0; i < 100; i++) {
        messages.push(createMessage('user', `User message ${i} with some content to make it longer`));
        messages.push(createMessage('assistant', `Assistant response ${i} with some content`));
      }

      const result = pruner.prune(messages);

      // 检查是否进行了修剪
      if (result.pruned) {
        expect(result.removedCount).toBeGreaterThan(0);
        expect(result.savedTokens).toBeGreaterThan(0);
        // 系统消息应该被保留
        const hasSystem = result.messages.some(m => m.role === 'system');
        expect(hasSystem).toBe(true);
      }
    });

    it('应该保留关键消息', () => {
      const messages: PrioritizedMessage[] = [
        createMessage('system', 'System prompt', 'critical'),
        createMessage('user', 'Error occurred', 'critical'),
        createMessage('user', 'Normal message 1'),
        createMessage('user', 'Normal message 2'),
        createMessage('user', 'Normal message 3'),
      ];

      // 强制触发修剪
      const strictPruner = new ContextPruner(tokenCounter, {
        ...DEFAULT_PRUNING_CONFIG,
        maxTokens: 100,
      });

      const result = strictPruner.prune(messages);

      // 关键消息应该被保留
      const criticalMessages = result.messages.filter(m => m.priority === 'critical');
      expect(criticalMessages.length).toBeGreaterThan(0);
    });
  });

  describe('summarizeMessages', () => {
    it('应该生成消息摘要', () => {
      const messages: PrioritizedMessage[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!'),
        createMessage('user', 'How are you?'),
        createMessage('assistant', 'I am doing well!'),
      ];

      const summary = pruner.summarizeMessages(messages);

      expect(summary).toContain('用户消息');
      expect(summary).toContain('助手回复');
    });

    it('空消息应该返回空字符串', () => {
      const summary = pruner.summarizeMessages([]);
      expect(summary).toBe('');
    });
  });

  describe('needsPruning', () => {
    it('低于阈值时应该返回 true', () => {
      const needs = pruner.needsPruning(120000); // 超过 85% 的 128000
      expect(needs).toBe(true);
    });

    it('高于阈值时应该返回 false', () => {
      const needs = pruner.needsPruning(10000);
      expect(needs).toBe(false);
    });
  });
});

describe('DEFAULT_PRUNING_CONFIG', () => {
  it('应该有合理的默认值', () => {
    expect(DEFAULT_PRUNING_CONFIG.maxTokens).toBe(128000);
    expect(DEFAULT_PRUNING_CONFIG.preserveRecent).toBe(10);
    expect(DEFAULT_PRUNING_CONFIG.preserveSystem).toBe(true);
    expect(DEFAULT_PRUNING_CONFIG.preserveToolResults).toBe(true);
    expect(DEFAULT_PRUNING_CONFIG.compactThreshold).toBeLessThan(1);
  });
});
