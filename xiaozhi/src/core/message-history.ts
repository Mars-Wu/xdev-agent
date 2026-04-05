// src/core/message-history.ts
// 消息历史管理 - 支持上下文压缩（与记忆系统联动）

import { createLogger } from '../utils/logger'

const logger = createLogger('message-history')

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * 消息内容块
 */
export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  source?: {
    type: 'base64'
    media_type: string
    data: string
  }
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

/**
 * 消息
 */
export interface Message {
  role: MessageRole
  content: string | ContentBlock[]
  timestamp?: Date
  importance?: number // 0-10，用于压缩时保留重要消息
}

/**
 * 消息历史配置
 */
export interface MessageHistoryConfig {
  maxMessages: number
  maxTokens: number
  preserveRecent: number
  enableCompression: boolean
  compressionThreshold: number // 触发压缩的使用率阈值 (0-1)
  enableMemoryExtraction: boolean // 压缩时是否提取记忆
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: MessageHistoryConfig = {
  maxMessages: 1000,
  maxTokens: 180_000, // 留一些余量
  preserveRecent: 10,
  enableCompression: true,
  compressionThreshold: 0.92, // 92% 使用率触发压缩
  enableMemoryExtraction: true,
}

/**
 * 压缩回调
 */
export type CompressionCallback = (result: {
  tokensBefore: number
  tokensAfter: number
  extractedMemories: number
}) => void

/**
 * 消息历史管理器
 */
export class MessageHistoryManager {
  private messages: Message[] = []
  private config: MessageHistoryConfig
  private currentTokens: number = 0
  private compressionCallback?: CompressionCallback
  private isCompressing: boolean = false

  constructor(config: Partial<MessageHistoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 设置压缩回调
   */
  onCompression(callback: CompressionCallback): void {
    this.compressionCallback = callback
  }

  /**
   * 添加消息
   */
  addMessage(message: Message): void {
    this.messages.push({
      ...message,
      timestamp: message.timestamp || new Date(),
    })

    // 估算 token 数
    this.currentTokens += this.estimateTokens(message)

    // 检查是否需要压缩（避免递归）
    if (
      !this.isCompressing &&
      this.config.enableCompression &&
      this.currentTokens > this.config.maxTokens * this.config.compressionThreshold
    ) {
      this.compress()
    }
  }

  /**
   * 批量添加消息
   */
  addMessages(messages: Message[]): void {
    for (const msg of messages) {
      this.addMessage(msg)
    }
  }

  /**
   * 获取所有消息
   */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /**
   * 获取最近 N 条消息
   */
  getRecentMessages(count: number = this.config.preserveRecent): Message[] {
    return this.messages.slice(-count)
  }

  /**
   * 清空历史
   */
  clear(): void {
    this.messages = []
    this.currentTokens = 0
    logger.info('消息历史已清空')
  }

  /**
   * 获取当前 token 估算
   */
  getTokenCount(): number {
    return this.currentTokens
  }

  /**
   * 获取消息数量
   */
  getMessageCount(): number {
    return this.messages.length
  }

  /**
   * 获取使用率
   */
  getUsageRatio(): number {
    return this.currentTokens / this.config.maxTokens
  }

  /**
   * 检查是否需要压缩
   */
  needsCompression(): boolean {
    return this.currentTokens > this.config.maxTokens * this.config.compressionThreshold
  }

  /**
   * 压缩历史（同步版本，快速压缩）
   */
  compress(): void {
    if (this.messages.length <= this.config.preserveRecent) {
      return
    }

    this.isCompressing = true
    const before = this.messages.length
    const beforeTokens = this.currentTokens

    // 保留最近消息
    const recent = this.messages.slice(-this.config.preserveRecent)

    // 旧消息按重要性排序
    const oldMessages = this.messages.slice(0, -this.config.preserveRecent)
    const important = oldMessages
      .filter((m) => (m.importance || 0) >= 5)
      .slice(0, 20) // 最多保留 20 条重要消息

    // 创建摘要
    const summary = this.createSummary(oldMessages.filter((m) => (m.importance || 0) < 5))

    // 重建历史
    this.messages = []
    this.currentTokens = 0

    // 添加摘要
    if (summary) {
      this.addMessage({
        role: 'system',
        content: `[历史摘要]\n${summary}`,
        importance: 10,
      })
    }

    // 添加重要消息
    for (const msg of important) {
      this.messages.push({ ...msg })
      this.currentTokens += this.estimateTokens(msg)
    }

    // 添加最近消息
    for (const msg of recent) {
      this.messages.push({ ...msg })
      this.currentTokens += this.estimateTokens(msg)
    }

    const after = this.messages.length
    const afterTokens = this.currentTokens

    logger.info(
      `历史压缩完成: ${before} -> ${after} 消息, ${beforeTokens} -> ${afterTokens} tokens`,
    )

    this.isCompressing = false

    // 触发回调
    this.compressionCallback?.({
      tokensBefore: beforeTokens,
      tokensAfter: afterTokens,
      extractedMemories: 0, // 同步版本不提取记忆
    })
  }

  /**
   * 异步压缩（与记忆系统联动）
   * 使用 LLM 生成更好的摘要，并提取记忆
   */
  async compactAsync(): Promise<{
    tokensBefore: number
    tokensAfter: number
    extractedMemories: number
  }> {
    if (this.messages.length <= this.config.preserveRecent) {
      return { tokensBefore: this.currentTokens, tokensAfter: this.currentTokens, extractedMemories: 0 }
    }

    this.isCompressing = true
    const beforeTokens = this.currentTokens

    try {
      // 动态导入避免循环依赖
      const { getContextCompressor } = await import('../context/compressor')
      const { getMemoryManager } = await import('../memory/memory-manager')

      const compressor = getContextCompressor()
      const memoryManager = getMemoryManager()

      // 转换消息格式
      const contextMessages = this.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
        timestamp: m.timestamp?.getTime(),
      }))

      // 执行压缩
      const result = await compressor.compact(contextMessages)

      // 保存提取的记忆
      for (const memory of result.extractedMemories) {
        await memoryManager.addMemory({
          content: memory.content,
          type: memory.type,
          scope: memory.scope,
          category: memory.category,
          importance: memory.importance,
          tags: memory.tags,
        })
      }

      // 更新消息历史
      this.messages = result.compressedMessages.map(m => ({
        role: m.role as MessageRole,
        content: m.content,
        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        importance: m.role === 'system' ? 10 : 5,
      }))
      this.currentTokens = result.tokensAfter

      logger.info(
        `异步压缩完成: ${result.tokensBefore} -> ${result.tokensAfter} tokens, ` +
        `提取 ${result.extractedMemories.length} 条记忆`
      )

      this.isCompressing = false

      return {
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        extractedMemories: result.extractedMemories.length,
      }
    } catch (error) {
      logger.error('异步压缩失败，回退到同步压缩:', error)
      this.isCompressing = false
      this.compress()
      return {
        tokensBefore: beforeTokens,
        tokensAfter: this.currentTokens,
        extractedMemories: 0,
      }
    }
  }

  /**
   * 创建摘要
   */
  private createSummary(messages: Message[]): string | null {
    if (messages.length === 0) return null

    // 提取关键信息
    const userMessages = messages.filter((m) => m.role === 'user')
    const assistantMessages = messages.filter((m) => m.role === 'assistant')

    const parts: string[] = []

    // 用户主要请求
    if (userMessages.length > 0) {
      const firstUser = userMessages[0]
      const content =
        typeof firstUser.content === 'string' ? firstUser.content : firstUser.content[0]?.text || ''
      if (content) {
        parts.push(`主要请求: ${content.slice(0, 200)}...`)
      }
    }

    // 助手主要响应
    if (assistantMessages.length > 0) {
      const lastAssistant = assistantMessages[assistantMessages.length - 1]
      const content =
        typeof lastAssistant.content === 'string'
          ? lastAssistant.content
          : lastAssistant.content[0]?.text || ''
      if (content) {
        parts.push(`最终响应: ${content.slice(0, 200)}...`)
      }
    }

    return parts.length > 0 ? parts.join('\n') : null
  }

  /**
   * 估算消息 token 数
   */
  private estimateTokens(message: Message): number {
    let text = ''

    if (typeof message.content === 'string') {
      text = message.content
    } else {
      for (const block of message.content) {
        if (block.text) text += block.text
        if (block.content) text += block.content
      }
    }

    // 简单估算：中文约 1.5 字符/token，英文约 4 字符/token
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars

    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  /**
   * 序列化为 JSON 字符串（用于话题 history 分桶持久化）
   */
  serialize(): string {
    return this.export()
  }

  /**
   * 从 JSON 字符串恢复 history（保留当前 config，只替换消息内容）
   */
  deserialize(json: string): void {
    if (!json || json === '[]' || json.trim() === '') {
      this.clear()
      return
    }
    this.import(json)
  }

  /**
   * 获取当前状态统计（消息数 + 估算 token 数）
   */
  stats(): { messageCount: number; estimatedTokens: number } {
    return {
      messageCount: this.getMessageCount(),
      estimatedTokens: this.getTokenCount(),
    }
  }

  /**
   * 导出历史
   */
  export(): string {
    return JSON.stringify(
      this.messages.map((m) => ({
        ...m,
        timestamp: m.timestamp?.toISOString(),
      })),
      null,
      2,
    )
  }

  /**
   * 导入历史
   */
  import(data: string): void {
    try {
      const messages = JSON.parse(data)
      this.clear()
      for (const msg of messages) {
        this.addMessage({
          ...msg,
          timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
        })
      }
      logger.info(`导入 ${messages.length} 条消息`)
    } catch (error) {
      logger.error('导入消息历史失败:', error)
    }
  }
}

/**
 * 转换为 API 格式的消息
 */
export function toApiMessages(messages: Message[]): Array<{
  role: MessageRole
  content: string | ContentBlock[]
}> {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
