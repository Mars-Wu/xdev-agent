// src/expert/context-pruning.ts
// 上下文修剪策略 - 智能管理对话历史长度
// 参考 OpenClaw 的 session-pruning 设计

import { createLogger } from '../utils/logger';
import { TokenCounter, DialogMessage, estimateTokens } from './token-counter';

const logger = createLogger('context-pruning');

/**
 * 消息优先级
 */
export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * 带优先级的消息
 */
export interface PrioritizedMessage extends DialogMessage {
  priority: MessagePriority;
  timestamp?: Date;
  // 是否可以被摘要替代
  summarizable?: boolean;
  // 摘要内容（如果已被摘要）
  summary?: string;
}

/**
 * 修剪策略配置
 */
export interface PruningConfig {
  // 最大 token 数
  maxTokens: number;
  // 保留最近 N 条消息
  preserveRecent: number;
  // 是否保留系统消息
  preserveSystem: boolean;
  // 是否保留工具调用结果
  preserveToolResults: boolean;
  // 压缩阈值（剩余空间比例）
  compactThreshold: number;
  // 是否启用摘要压缩
  enableSummarization: boolean;
}

/**
 * 默认修剪配置
 */
export const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  maxTokens: 128000,       // Claude 3.5 Sonnet 上下文窗口
  preserveRecent: 10,       // 保留最近 10 条消息
  preserveSystem: true,     // 保留系统消息
  preserveToolResults: true, // 保留工具结果
  compactThreshold: 0.15,   // 剩余 15% 时触发压缩
  enableSummarization: true,
};

/**
 * 修剪结果
 */
export interface PruningResult {
  // 修剪后的消息
  messages: PrioritizedMessage[];
  // 是否进行了修剪
  pruned: boolean;
  // 移除的消息数
  removedCount: number;
  // 原始 token 数
  originalTokens: number;
  // 修剪后 token 数
  prunedTokens: number;
  // 节省的 token 数
  savedTokens: number;
  // 修剪策略说明
  strategy: string;
}

/**
 * 上下文修剪器
 *
 * 实现智能的对话历史修剪，保持关键信息的同时控制上下文长度。
 */
export class ContextPruner {
  private tokenCounter: TokenCounter;
  private config: PruningConfig;

  constructor(
    tokenCounter: TokenCounter,
    config: Partial<PruningConfig> = {}
  ) {
    this.tokenCounter = tokenCounter;
    this.config = { ...DEFAULT_PRUNING_CONFIG, ...config };
  }

  /**
   * 修剪消息历史
   */
  prune(messages: PrioritizedMessage[]): PruningResult {
    const originalTokens = this.tokenCounter.estimateMessages(messages).total;

    // 检查是否需要修剪
    if (!this.needsPruning(originalTokens)) {
      return {
        messages,
        pruned: false,
        removedCount: 0,
        originalTokens,
        prunedTokens: originalTokens,
        savedTokens: 0,
        strategy: 'none',
      };
    }

    logger.info(`开始修剪上下文，当前 ${originalTokens} tokens`);

    // Step 1: 按优先级分类
    const { critical, high, normal, low } = this.categorizeByPriority(messages);

    // Step 2: 计算保留预算
    const targetTokens = Math.floor(this.config.maxTokens * 0.7); // 目标 70% 利用率

    // Step 3: 构建修剪后的消息列表
    let prunedMessages: PrioritizedMessage[] = [];
    let currentTokens = 0;

    // 3.1 先添加关键消息
    for (const msg of critical) {
      const msgTokens = this.tokenCounter.estimateMessage(msg);
      prunedMessages.push(msg);
      currentTokens += msgTokens;
    }

    // 3.2 添加高优先级消息
    for (const msg of high) {
      const msgTokens = this.tokenCounter.estimateMessage(msg);
      if (currentTokens + msgTokens <= targetTokens) {
        prunedMessages.push(msg);
        currentTokens += msgTokens;
      }
    }

    // 3.3 添加普通消息（保留最近 N 条）
    const recentNormal = this.getRecentMessages(normal, this.config.preserveRecent);
    for (const msg of recentNormal) {
      const msgTokens = this.tokenCounter.estimateMessage(msg);
      if (currentTokens + msgTokens <= targetTokens) {
        prunedMessages.push(msg);
        currentTokens += msgTokens;
      }
    }

    // 3.4 如果空间还够，添加低优先级消息
    if (currentTokens < targetTokens * 0.9) {
      const recentLow = this.getRecentMessages(low, 3);
      for (const msg of recentLow) {
        const msgTokens = this.tokenCounter.estimateMessage(msg);
        if (currentTokens + msgTokens <= targetTokens) {
          prunedMessages.push(msg);
          currentTokens += msgTokens;
        }
      }
    }

    // Step 4: 按时间排序
    prunedMessages = this.sortByTime(prunedMessages);

    const prunedTokens = this.tokenCounter.estimateMessages(prunedMessages).total;
    const savedTokens = originalTokens - prunedTokens;

    logger.info(
      `修剪完成: ${messages.length} -> ${prunedMessages.length} 条消息, ` +
      `${originalTokens} -> ${prunedTokens} tokens (节省 ${savedTokens})`
    );

    return {
      messages: prunedMessages,
      pruned: true,
      removedCount: messages.length - prunedMessages.length,
      originalTokens,
      prunedTokens,
      savedTokens,
      strategy: 'priority-based',
    };
  }

  /**
   * 检查是否需要修剪
   */
  needsPruning(currentTokens: number): boolean {
    const threshold = this.config.maxTokens * this.config.compactThreshold;
    return currentTokens > this.config.maxTokens - threshold;
  }

  /**
   * 计算消息优先级
   */
  calculatePriority(message: DialogMessage): MessagePriority {
    const content = message.content.toLowerCase();

    // 关键：系统消息、错误信息、重要决策
    if (message.role === 'system') return 'critical';

    // 关键：包含重要关键词
    const criticalKeywords = ['错误', 'error', '失败', 'failed', '重要', 'important'];
    if (criticalKeywords.some(kw => content.includes(kw))) return 'critical';

    // 关键：工具调用结果
    if (message.role === 'tool') return 'critical';

    // 高优先级：用户明确指令、代码相关
    const highKeywords = ['请', '帮我', '代码', 'code', '修改', 'fix', '实现'];
    if (highKeywords.some(kw => content.includes(kw))) return 'high';

    // 高优先级：较长的消息（可能包含重要信息）
    if (message.content.length > 500) return 'high';

    // 低优先级：简短确认、闲聊
    const lowPatterns = [/^(好的|ok|收到|明白|嗯|是|否)[\s!.。！]*$/i];
    if (lowPatterns.some(p => p.test(content.trim()))) return 'low';

    return 'normal';
  }

  /**
   * 按优先级分类消息
   */
  private categorizeByPriority(messages: PrioritizedMessage[]): {
    critical: PrioritizedMessage[];
    high: PrioritizedMessage[];
    normal: PrioritizedMessage[];
    low: PrioritizedMessage[];
  } {
    const result = {
      critical: [] as PrioritizedMessage[],
      high: [] as PrioritizedMessage[],
      normal: [] as PrioritizedMessage[],
      low: [] as PrioritizedMessage[],
    };

    for (const msg of messages) {
      // 使用已有的优先级或重新计算
      const priority = msg.priority || this.calculatePriority(msg);

      switch (priority) {
        case 'critical':
          result.critical.push(msg);
          break;
        case 'high':
          result.high.push(msg);
          break;
        case 'low':
          result.low.push(msg);
          break;
        default:
          result.normal.push(msg);
      }
    }

    return result;
  }

  /**
   * 获取最近的消息
   */
  private getRecentMessages(messages: PrioritizedMessage[], count: number): PrioritizedMessage[] {
    if (messages.length <= count) return messages;
    return messages.slice(-count);
  }

  /**
   * 按时间排序消息
   */
  private sortByTime(messages: PrioritizedMessage[]): PrioritizedMessage[] {
    return [...messages].sort((a, b) => {
      const timeA = a.timestamp?.getTime() || 0;
      const timeB = b.timestamp?.getTime() || 0;
      return timeA - timeB;
    });
  }

  /**
   * 生成消息摘要
   */
  summarizeMessages(messages: PrioritizedMessage[]): string {
    if (messages.length === 0) return '';

    const summary: string[] = ['[历史摘要]'];

    // 按角色统计
    const userMessages = messages.filter(m => m.role === 'user').length;
    const assistantMessages = messages.filter(m => m.role === 'assistant').length;
    const toolMessages = messages.filter(m => m.role === 'tool').length;

    summary.push(`- 用户消息: ${userMessages} 条`);
    summary.push(`- 助手回复: ${assistantMessages} 条`);
    summary.push(`- 工具调用: ${toolMessages} 条`);

    // 提取关键主题（简单实现）
    const keywords = this.extractKeywords(messages);
    if (keywords.length > 0) {
      summary.push(`- 涉及主题: ${keywords.slice(0, 5).join(', ')}`);
    }

    return summary.join('\n');
  }

  /**
   * 提取关键词
   */
  private extractKeywords(messages: PrioritizedMessage[]): string[] {
    const wordCount = new Map<string, number>();

    for (const msg of messages) {
      // 简单分词（按空格和标点）
      const words = msg.content
        .toLowerCase()
        .split(/[\s,.;:!?，。；：！？]+/)
        .filter(w => w.length >= 2 && w.length <= 10);

      for (const word of words) {
        wordCount.set(word, (wordCount.get(word) || 0) + 1);
      }
    }

    // 返回高频词
    return Array.from(wordCount.entries())
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PruningConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('修剪配置已更新');
  }

  /**
   * 获取当前配置
   */
  getConfig(): PruningConfig {
    return { ...this.config };
  }
}

/**
 * 创建默认修剪器
 */
export function createContextPruner(
  tokenCounter: TokenCounter,
  config?: Partial<PruningConfig>
): ContextPruner {
  return new ContextPruner(tokenCounter, config);
}
