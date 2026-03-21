// src/expert/token-counter.ts
// Token 计数器 - 估算文本的 token 数量
// 提供多种估算策略，支持中英文混合文本

import { createLogger } from '../utils/logger';

const logger = createLogger('token-counter');

/**
 * Token 估算策略
 */
export type TokenEstimationStrategy = 'simple' | 'gpt' | 'claude';

/**
 * Token 计数器配置
 */
export interface TokenCounterConfig {
  strategy?: TokenEstimationStrategy;
  // 不同模型的 token 比例
  charsPerToken?: {
    english: number;    // 英文字符/token，默认 4
    chinese: number;    // 中文字符/token，默认 1.5
    code: number;       // 代码字符/token，默认 3
  };
}

/**
 * 消息角色
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 对话消息
 */
export interface DialogMessage {
  role: MessageRole;
  content: string;
  name?: string;
  // 元数据（不参与 token 计算）
  metadata?: Record<string, unknown>;
}

/**
 * Token 计数结果
 */
export interface TokenCountResult {
  total: number;
  breakdown: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  estimated: boolean;  // 是否为估算值
}

/**
 * Token 计数器
 *
 * 提供轻量级的 token 估算，无需加载 tiktoken 等重量级库。
 * 估算公式基于经验值，对于精确计数有 ±10% 的误差。
 */
export class TokenCounter {
  private config: Required<TokenCounterConfig>;

  constructor(config: TokenCounterConfig = {}) {
    this.config = {
      strategy: config.strategy || 'claude',
      charsPerToken: {
        english: config.charsPerToken?.english || 4,
        chinese: config.charsPerToken?.chinese || 1.5,
        code: config.charsPerToken?.code || 3,
      },
    };
  }

  /**
   * 估算单条消息的 token 数
   */
  estimateMessage(message: DialogMessage): number {
    // 消息格式开销：role + 结构
    const formatOverhead = 4; // 每条消息的固定开销

    // 内容 token
    const contentTokens = this.estimateText(message.content);

    // name 字段（如果有）
    const nameTokens = message.name ? this.estimateText(message.name) : 0;

    return formatOverhead + contentTokens + nameTokens;
  }

  /**
   * 估算消息数组的总 token 数
   */
  estimateMessages(messages: DialogMessage[]): TokenCountResult {
    const breakdown = {
      system: 0,
      user: 0,
      assistant: 0,
      tool: 0,
    };

    for (const msg of messages) {
      const tokens = this.estimateMessage(msg);
      breakdown[msg.role] += tokens;
    }

    // 对话格式开销
    const conversationOverhead = 3;

    return {
      total: breakdown.system + breakdown.user + breakdown.assistant + breakdown.tool + conversationOverhead,
      breakdown,
      estimated: true,
    };
  }

  /**
   * 估算文本的 token 数
   */
  estimateText(text: string): number {
    if (!text) return 0;

    // 分类统计字符
    let englishChars = 0;
    let chineseChars = 0;
    let codeChars = 0;

    // 简单的文本分类启发式
    const isCodeLike = this.detectCodeContent(text);

    for (const char of text) {
      const code = char.charCodeAt(0);

      // 中文字符范围（CJK 统一汉字）
      if (code >= 0x4e00 && code <= 0x9fff) {
        chineseChars++;
      }
      // 空白字符不计入
      else if (char === ' ' || char === '\n' || char === '\t') {
        // 空白字符折半计算
        englishChars += 0.5;
      }
      // ASCII 字符
      else if (code < 128) {
        if (isCodeLike) {
          codeChars++;
        } else {
          englishChars++;
        }
      }
      // 其他 Unicode 字符（如日文、韩文等）
      else {
        chineseChars++;
      }
    }

    // 按比例计算 token
    const { english, chinese, code } = this.config.charsPerToken;
    const tokens =
      Math.ceil(englishChars / english) +
      Math.ceil(chineseChars / chinese) +
      Math.ceil(codeChars / code);

    // Claude 策略需要额外 +10% 缓冲
    if (this.config.strategy === 'claude') {
      return Math.ceil(tokens * 1.1);
    }

    return tokens;
  }

  /**
   * 检测文本是否像代码
   */
  private detectCodeContent(text: string): boolean {
    // 代码特征检测
    const codeIndicators = [
      /^[\s]*(function|const|let|var|class|import|export|if|for|while)/m,
      /[{}\[\]();]$/,
      /\b(def|fn|func|pub|priv|async|await)\b/,
      /^\s*\/\//m,  // 注释
      /```/,        // 代码块标记
    ];

    return codeIndicators.some(pattern => pattern.test(text));
  }

  /**
   * 估算系统提示词的 token 数
   */
  estimateSystemPrompt(prompt: string): number {
    const tokens = this.estimateText(prompt);
    // 系统提示词有额外开销
    return tokens + 10;
  }

  /**
   * 计算剩余可用 token
   */
  calculateRemaining(
    messages: DialogMessage[],
    maxTokens: number,
    systemPrompt?: string
  ): number {
    let used = 0;

    // 系统提示词
    if (systemPrompt) {
      used += this.estimateSystemPrompt(systemPrompt);
    }

    // 消息历史
    used += this.estimateMessages(messages).total;

    // 预留响应空间
    const responseReserve = 4096;

    return Math.max(0, maxTokens - used - responseReserve);
  }

  /**
   * 判断是否需要压缩
   */
  needsCompaction(
    messages: DialogMessage[],
    threshold: number,
    systemPrompt?: string
  ): boolean {
    const remaining = this.calculateRemaining(messages, threshold, systemPrompt);
    return remaining < threshold * 0.1; // 剩余不足 10% 时需要压缩
  }
}

// 默认实例
export const tokenCounter = new TokenCounter();

/**
 * 快捷函数：估算文本 token 数
 */
export function estimateTokens(text: string): number {
  return tokenCounter.estimateText(text);
}

/**
 * 快捷函数：估算消息数组 token 数
 */
export function estimateMessagesTokens(messages: DialogMessage[]): number {
  return tokenCounter.estimateMessages(messages).total;
}
