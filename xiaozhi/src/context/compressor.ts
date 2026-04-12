// src/context/compressor.ts
// 上下文压缩器 - 3层压缩机制（s06）

import { createLogger } from '../utils/logger';
import { getLLMClient } from '../core';
import { getMemoryExtractor } from '../memory/memory-extractor';
import { getMemoryRetriever } from '../memory/memory-retriever';
import { MemoryEntry, MemoryType, MemoryScope } from '../memory/types';
import { COMPACT_PROMPT } from './prompt';
import { configManager } from '../config';

const logger = createLogger('compressor');

/**
 * 压缩级别（s06 3层压缩）
 */
export enum CompressionLevel {
  /** 微压缩：去除冗余，不调用 LLM */
  MICRO = 'micro',
  /** 自动压缩：LLM 摘要，平衡质量和速度 */
  AUTO = 'auto',
  /** 手动压缩：完全压缩，最大化压缩比 */
  MANUAL = 'manual',
}

/**
 * 压缩配置
 */
export interface CompressionConfig {
  /** 触发阈值（上下文使用率）- micro 压缩 */
  microThreshold: number;
  /** 触发阈值 - auto 压缩 */
  autoThreshold: number;
  /** 目标压缩比 */
  targetRatio: number;
  /** 保留用户消息 */
  preserveUserMessages: boolean;
  /** 保留错误信息 */
  preserveErrors: boolean;
  /** 最大摘要 token */
  maxSummaryTokens: number;
}

const DEFAULT_CONFIG: CompressionConfig = {
  microThreshold: 0.75,  // 75% 触发 micro 压缩
  autoThreshold: 0.92,   // 92% 触发 auto 压缩
  targetRatio: 6.8,
  preserveUserMessages: true,
  preserveErrors: true,
  maxSummaryTokens: 500,
};

/**
 * 消息类型
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 压缩结果
 */
export interface CompressionResult {
  /** 压缩后的消息 */
  compressedMessages: Message[];
  /** 提取的记忆 */
  extractedMemories: MemoryEntry[];
  /** 压缩前 token 数 */
  tokensBefore: number;
  /** 压缩后 token 数 */
  tokensAfter: number;
  /** 压缩比 */
  compressionRatio: number;
}

/**
 * 消息重要性评分
 */
function scoreMessageImportance(message: Message, index: number, total: number): number {
  let score = 0;
  const content = message.content.toLowerCase();

  // 用户消息：高优先级
  if (message.role === 'user') score += 10;

  // 包含错误：保留
  if (content.includes('错误') || content.includes('失败') || content.includes('error')) {
    score += 8;
  }

  // 决策相关：保留
  if (content.includes('决定') || content.includes('选择') || content.includes('确定')) {
    score += 7;
  }

  // 任务相关：保留
  if (content.includes('任务') || content.includes('完成') || content.includes('目标')) {
    score += 6;
  }

  // 最近的消息：加权（最近 20% 加 5 分）
  const recencyRatio = index / total;
  if (recencyRatio > 0.8) score += 5;
  else if (recencyRatio > 0.5) score += 3;

  // 工具结果：可压缩
  if (content.includes('tool_result') || content.includes('工具结果')) {
    score += 2;
  }

  return score;
}

/**
 * 上下文压缩器 - 3层压缩机制
 */
export class ContextCompressor {
  private config: CompressionConfig;
  private llmClient = getLLMClient();
  private memoryExtractor = getMemoryExtractor();
  private memoryRetriever = getMemoryRetriever();

  constructor(config: Partial<CompressionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检测需要哪个级别的压缩
   */
  getCompressionLevel(messages: Message[], maxTokens: number): CompressionLevel | null {
    const currentTokens = this.estimateTokens(messages);
    const usage = currentTokens / maxTokens;

    if (usage >= this.config.autoThreshold) {
      return CompressionLevel.AUTO;
    }
    if (usage >= this.config.microThreshold) {
      return CompressionLevel.MICRO;
    }
    return null;
  }

  /**
   * 检测是否需要压缩（向后兼容）
   */
  shouldCompress(messages: Message[], maxTokens: number): boolean {
    return this.getCompressionLevel(messages, maxTokens) !== null;
  }

  /**
   * 智能压缩 - 根据上下文使用率自动选择压缩级别
   */
  async compact(messages: Message[], level?: CompressionLevel): Promise<CompressionResult> {
    const tokensBefore = this.estimateTokens(messages);
    logger.info(`开始压缩: ${messages.length} 条消息, ${tokensBefore} tokens`);

    // 如果没有指定级别，使用默认逻辑
    const compressionLevel = level || CompressionLevel.AUTO;

    let result: CompressionResult;

    switch (compressionLevel) {
      case CompressionLevel.MICRO:
        result = await this.microCompact(messages);
        break;
      case CompressionLevel.MANUAL:
        result = await this.manualCompact(messages);
        break;
      case CompressionLevel.AUTO:
      default:
        result = await this.autoCompact(messages);
        break;
    }

    return result;
  }

  /**
   * 第1层：Micro 压缩 - 轻量级，不调用 LLM
   *
   * 特点：
   * - 去除重复内容
   * - 截断过长的工具输出
   * - 压缩空白和格式
   */
  private async microCompact(messages: Message[]): Promise<CompressionResult> {
    const tokensBefore = this.estimateTokens(messages);
    logger.info('执行 Micro 压缩（轻量级）');

    const compressed: Message[] = [];
    const seen = new Set<string>();

    for (const msg of messages) {
      // 1. 去重
      const contentHash = this.hashContent(msg.content);
      if (seen.has(contentHash) && msg.role !== 'user') {
        continue;
      }
      seen.add(contentHash);

      // 2. 截断长工具输出
      let content = msg.content;
      if (content.length > 5000 && this.isToolOutput(content)) {
        content = this.truncateToolOutput(content, 2000);
      }

      // 3. 压缩空白
      content = this.compressWhitespace(content);

      compressed.push({ ...msg, content });
    }

    const tokensAfter = this.estimateTokens(compressed);
    const ratio = tokensBefore / tokensAfter;

    logger.info(`Micro 压缩完成: ${tokensBefore} → ${tokensAfter} tokens (${ratio.toFixed(1)}x)`);

    return {
      compressedMessages: compressed,
      extractedMemories: [],
      tokensBefore,
      tokensAfter,
      compressionRatio: ratio,
    };
  }

  /**
   * 第2层：Auto 压缩 - LLM 摘要，平衡质量和速度
   */
  private async autoCompact(messages: Message[]): Promise<CompressionResult> {
    const tokensBefore = this.estimateTokens(messages);
    logger.info('执行 Auto 压缩（LLM 摘要）');

    // 1. 从旧消息提取记忆
    const extractedMemories = await this.extractMemoriesFromMessages(messages);

    // 2. 分割消息：保留 vs 压缩
    const { preserve, compress } = this.categorizeMessages(messages);

    // 3. 生成摘要
    const summary = await this.generateSummary(compress);

    // 4. 检索相关记忆
    const relevantMemories = await this.retrieveRelevantMemories(messages);

    // 5. 构建新的消息历史
    const compressedMessages = this.buildCompressedHistory(
      preserve,
      summary,
      relevantMemories
    );

    const tokensAfter = this.estimateTokens(compressedMessages);
    const compressionRatio = tokensBefore / tokensAfter;

    logger.info(
      `Auto 压缩完成: ${tokensBefore} → ${tokensAfter} tokens (${compressionRatio.toFixed(1)}x)`
    );

    return {
      compressedMessages,
      extractedMemories,
      tokensBefore,
      tokensAfter,
      compressionRatio,
    };
  }

  /**
   * 第3层：Manual 压缩 - 用户触发的完全压缩
   *
   * 特点：
   * - 最大化压缩比
   * - 保留核心决策和关键信息
   * - 生成详细的会话摘要
   */
  private async manualCompact(messages: Message[]): Promise<CompressionResult> {
    const tokensBefore = this.estimateTokens(messages);
    logger.info('执行 Manual 压缩（完全压缩）');

    // 1. 提取所有记忆
    const extractedMemories = await this.extractMemoriesFromMessages(messages);

    // 2. 只保留最后几条消息和关键决策
    const keyMessages = this.extractKeyMessages(messages);

    // 3. 生成详细摘要
    const summary = await this.generateDetailedSummary(messages);

    // 4. 检索所有相关记忆
    const relevantMemories = await this.retrieveRelevantMemories(messages);

    // 5. 构建最小化历史
    const compressedMessages = this.buildMinimalHistory(
      keyMessages,
      summary,
      relevantMemories
    );

    const tokensAfter = this.estimateTokens(compressedMessages);
    const compressionRatio = tokensBefore / tokensAfter;

    logger.info(
      `Manual 压缩完成: ${tokensBefore} → ${tokensAfter} tokens (${compressionRatio.toFixed(1)}x)`
    );

    return {
      compressedMessages,
      extractedMemories,
      tokensBefore,
      tokensAfter,
      compressionRatio,
    };
  }

  /**
   * 提取关键消息
   */
  private extractKeyMessages(messages: Message[]): Message[] {
    const result: Message[] = [];

    // 保留所有用户消息的最后一条
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length > 0) {
      result.push(userMessages[userMessages.length - 1]);
    }

    // 保留包含决策的消息
    for (const msg of messages) {
      const content = msg.content.toLowerCase();
      if (
        content.includes('决定') ||
        content.includes('选择') ||
        content.includes('确认') ||
        content.includes('错误')
      ) {
        if (!result.includes(msg)) {
          result.push(msg);
        }
      }
    }

    return result;
  }

  /**
   * 生成详细摘要（用于 Manual 压缩）
   */
  private async generateDetailedSummary(messages: Message[]): Promise<string> {
    if (messages.length === 0) return '';

    const content = messages
      .map(m => `**${m.role}**: ${m.content}`)
      .join('\n\n');

    try {
      const response = await this.llmClient.chatSync({
        model: configManager.getConfig().model.defaultModel,
        maxTokens: 1500, // 更详细的摘要
        messages: [
          {
            role: 'user',
            content: `请生成以下对话的详细摘要，包括：
1. 主要任务和目标
2. 关键决策和选择
3. 遇到的问题和解决方案
4. 未完成的事项

对话内容：
${content.slice(0, 20000)}`,
          },
        ],
        system: '你是一个专业的对话摘要生成器，生成结构化、详细的摘要。',
      });

      return response.content;
    } catch (error) {
      logger.error('生成详细摘要失败:', error);
      return '[摘要生成失败]';
    }
  }

  /**
   * 构建最小化历史
   */
  private buildMinimalHistory(
    keyMessages: Message[],
    summary: string,
    memories: string
  ): Message[] {
    const result: Message[] = [];

    // 1. 添加完整摘要
    result.push({
      role: 'system',
      content: `## 会话摘要\n\n${summary}\n\n${memories}`,
    });

    // 2. 添加关键消息
    result.push(...keyMessages);

    return result;
  }

  // === 工具方法 ===

  /**
   * 计算内容哈希（用于去重）
   */
  private hashContent(content: string): string {
    // 简单哈希：取前 100 字符
    return content.slice(0, 100).replace(/\s+/g, ' ');
  }

  /**
   * 判断是否为工具输出
   */
  private isToolOutput(content: string): boolean {
    return (
      content.includes('tool_result') ||
      content.includes('工具结果') ||
      content.includes('执行结果') ||
      content.startsWith('{') ||
      content.startsWith('[')
    );
  }

  /**
   * 截断工具输出
   */
  private truncateToolOutput(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return (
      content.slice(0, maxLength / 2) +
      '\n...[已截断]...\n' +
      content.slice(-maxLength / 2)
    );
  }

  /**
   * 压缩空白字符
   */
  private compressWhitespace(content: string): string {
    return content
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  /**
   * 从消息中提取记忆
   */
  private async extractMemoriesFromMessages(messages: Message[]): Promise<MemoryEntry[]> {
    const memories: MemoryEntry[] = [];

    try {
      // 构建提取内容
      const content = messages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');

      // 使用 LLM 提取记忆
      const response = await this.llmClient.chatSync({
        model: configManager.getConfig().model.defaultModel,
        maxTokens: 1000,
        messages: [
          {
            role: 'user',
            content: `从以下对话中提取重要的长期记忆（用户偏好、决策、重要事实）：

${content.slice(0, 10000)}

返回 JSON 数组格式，每个元素包含：content（记忆内容）、category（preference/decision/fact）、importance（1-10）`,
          },
        ],
        system: '你是一个记忆提取专家，只提取有长期价值的信息。',
      });

      // 解析结果
      const parsed = this.parseMemoryResponse(response.content);
      memories.push(...parsed);
    } catch (error) {
      logger.error('提取记忆失败:', error);
    }

    return memories;
  }

  /**
   * 解析记忆响应
   */
  private parseMemoryResponse(content: string): MemoryEntry[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed.map((item: any) => ({
        id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        content: item.content || '',
        type: MemoryType.SEMANTIC,
        scope: MemoryScope.PRIVATE,
        category: item.category || 'fact',
        importance: Math.min(10, Math.max(1, item.importance || 5)),
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 0,
        tags: [],
      }));
    } catch {
      return [];
    }
  }

  /**
   * 分类消息：保留 vs 压缩
   */
  private categorizeMessages(
    messages: Message[]
  ): { preserve: Message[]; compress: Message[] } {
    const preserve: Message[] = [];
    const compress: Message[] = [];

    // 计算每条消息的重要性
    const scored = messages.map((msg, idx) => ({
      message: msg,
      score: scoreMessageImportance(msg, idx, messages.length),
    }));

    // 按重要性排序
    scored.sort((a, b) => b.score - a.score);

    // 保留前 30% 高分消息
    const preserveCount = Math.ceil(messages.length * 0.3);
    const preserveSet = new Set(scored.slice(0, preserveCount).map(s => s.message));

    for (const msg of messages) {
      if (preserveSet.has(msg)) {
        preserve.push(msg);
      } else {
        compress.push(msg);
      }
    }

    return { preserve, compress };
  }

  /**
   * 生成摘要
   */
  private async generateSummary(messages: Message[]): Promise<string> {
    if (messages.length === 0) return '';

    const content = messages
      .map(m => `**${m.role}**: ${m.content}`)
      .join('\n\n');

    try {
      const response = await this.llmClient.chatSync({
        model: configManager.getConfig().model.defaultModel,
        maxTokens: this.config.maxSummaryTokens,
        messages: [
          {
            role: 'user',
            content: `请将以下对话内容压缩为简洁的摘要：\n\n${content.slice(0, 15000)}`,
          },
        ],
        system: COMPACT_PROMPT,
      });

      return response.content;
    } catch (error) {
      logger.error('生成摘要失败:', error);
      return '[摘要生成失败]';
    }
  }

  /**
   * 检索相关记忆
   */
  private async retrieveRelevantMemories(messages: Message[]): Promise<string> {
    try {
      // 获取最后一个用户消息作为查询
      const lastUserMessage = [...messages]
        .reverse()
        .find(m => m.role === 'user');

      if (!lastUserMessage) return '';

      const memoryPrompt = await this.memoryRetriever.buildMemoryPrompt(
        lastUserMessage.content
      );

      return memoryPrompt;
    } catch (error) {
      logger.error('检索记忆失败:', error);
      return '';
    }
  }

  /**
   * 构建压缩后的历史
   *
   * Identity 重注入（p1-identity-reinject）：
   * 压缩后的 system 消息中嵌入当前 Agent 身份标记，
   * 防止模型在长对话后"忘记"自己是小智。
   */
  private buildCompressedHistory(
    preserve: Message[],
    summary: string,
    memories: string
  ): Message[] {
    const result: Message[] = [];

    // 身份锚点：始终重注入，防止压缩后丢失身份
    const identityAnchor = `## Agent Identity\n你是小智，AI 管家助手。当前会话已被压缩以节省上下文空间。\n`;

    const summaryBlock = summary
      ? `## 历史上下文摘要\n\n${summary}`
      : '';
    const memoryBlock = memories ? `\n\n${memories}` : '';

    result.push({
      role: 'system',
      content: `${identityAnchor}\n${summaryBlock}${memoryBlock}`,
    });

    // 2. 添加保留的消息
    result.push(...preserve);

    return result;
  }

  /**
   * 估算 token 数量（粗略：每 4 字符约 1 token）
   */
  estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      total += Math.ceil(msg.content.length / 4);
    }
    return total;
  }

  /**
   * 获取配置
   */
  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// 单例
let compressor: ContextCompressor | null = null;

/**
 * 获取压缩器
 */
export function getContextCompressor(): ContextCompressor {
  if (!compressor) {
    compressor = new ContextCompressor();
  }
  return compressor;
}

/**
 * 重置压缩器
 */
export function resetContextCompressor(): void {
  compressor = null;
}
