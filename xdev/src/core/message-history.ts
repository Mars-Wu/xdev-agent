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
  type: 'text' | 'image' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  thinking?: string
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
   * 压缩历史（同步版本）
   * 算法：Hermes ContextCompressor 移植版
   *   1. 旧工具结果剪枝（廉价预处理）
   *   2. 按 token 预算确定尾部边界（替代原固定 N 条）
   *   3. 边界对齐：不切断 tool_use/tool_result 对
   *   4. 中间部分生成简单摘要（同步版本直接生成，异步版本调辅助 LLM）
   *   5. 清理孤立 tool pair
   */
  compress(): void {
    const MIN_MESSAGES_TO_COMPRESS = 8
    if (this.messages.length <= MIN_MESSAGES_TO_COMPRESS) return

    this.isCompressing = true
    const before = this.messages.length
    const beforeTokens = this.currentTokens

    // 步骤1：旧工具结果剪枝
    const [pruned] = this._pruneOldToolResults(this.messages, 15)

    // 步骤2：token 预算确定尾部起始位置（保护最近约 20% token）
    const tailBudget = Math.floor(this.config.maxTokens * 0.20)
    let tailStart = this._findTailByTokenBudget(pruned, tailBudget)

    // 步骤3：保护头部（至少3条）
    const headEnd = Math.min(3, Math.floor(pruned.length * 0.1))
    // 头部对齐：跳过 tool_result 开头
    const alignedHead = this._alignBoundaryForward(pruned, headEnd)
    // 尾部对齐：不切断 tool_use/tool_result 对
    const alignedTail = this._alignBoundaryBackward(pruned, tailStart)

    // 压缩区域无效时降级到原始简单策略
    if (alignedHead >= alignedTail) {
      const recent = this.messages.slice(-this.config.preserveRecent)
      this.messages = []
      this.currentTokens = 0
      for (const msg of recent) {
        this.messages.push({ ...msg })
        this.currentTokens += this.estimateTokens(msg)
      }
      this.isCompressing = false
      return
    }

    // 步骤4：生成摘要
    const middle = pruned.slice(alignedHead, alignedTail)
    const head = pruned.slice(0, alignedHead)
    const tail = pruned.slice(alignedTail)
    const summary = this._createStructuredSummary(middle)

    // 步骤5：重建消息序列
    const summaryMsg: Message | null = summary
      ? { role: 'system', content: `[历史摘要]\n${summary}`, importance: 10 }
      : null

    this.messages = [
      ...head,
      ...(summaryMsg ? [summaryMsg] : []),
      ...tail,
    ]

    // 步骤6：清理孤立 tool pair
    this.messages = this._cleanOrphanedToolPairs(this.messages)

    // 重算 tokens
    this.currentTokens = this.messages.reduce((sum, m) => sum + this.estimateTokens(m), 0)

    logger.info(
      `历史压缩完成: ${before} -> ${this.messages.length} 消息, ${beforeTokens} -> ${this.currentTokens} tokens`,
    )

    this.isCompressing = false
    this.compressionCallback?.({
      tokensBefore: beforeTokens,
      tokensAfter: this.currentTokens,
      extractedMemories: 0,
    })
  }

  // ──────────────────────── 压缩辅助方法 ────────────────────────

  /**
   * 按 token 预算从尾部向前找切割位置
   * 返回尾部第一条消息的索引（保留预算内的消息）
   */
  private _findTailByTokenBudget(messages: Message[], budget: number): number {
    let tokens = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += this.estimateTokens(messages[i])
      if (tokens > budget) return i + 1
    }
    return 0
  }

  /**
   * 头部边界对齐：跳过 tool_result 消息（避免摘要区以 tool_result 开头）
   */
  private _alignBoundaryForward(messages: Message[], idx: number): number {
    while (idx < messages.length) {
      const msg = messages[idx]
      const content = msg.content
      const isToolResult =
        msg.role === 'user' &&
        Array.isArray(content) &&
        content.some((b: ContentBlock) => b.type === 'tool_result')
      if (!isToolResult) break
      idx++
    }
    return idx
  }

  /**
   * 尾部边界对齐：退出切割点直到不切断 tool_use/tool_result 对
   */
  private _alignBoundaryBackward(messages: Message[], idx: number): number {
    while (idx > 0) {
      const prev = messages[idx - 1]
      const content = prev.content
      const hasToolUse =
        prev.role === 'assistant' &&
        Array.isArray(content) &&
        content.some((b: ContentBlock) => b.type === 'tool_use')
      if (!hasToolUse) break
      idx--
    }
    return idx
  }

  /**
   * 替换超长旧工具结果为占位符（廉价预处理，不需要 LLM）
   */
  private _pruneOldToolResults(messages: Message[], keepLast: number): [Message[], number] {
    const PRUNED_PLACEHOLDER = '[旧工具输出已清除以节省上下文空间]'
    const MIN_PRUNE_CHARS = 200
    const result = messages.map((m) => ({ ...m }))
    let pruned = 0
    const boundary = Math.max(0, result.length - keepLast)
    for (let i = 0; i < boundary; i++) {
      const msg = result[i]
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      const hasToolResult = msg.content.some((b: ContentBlock) => b.type === 'tool_result')
      if (!hasToolResult) continue
      const newContent = msg.content.map((block: ContentBlock) => {
        if (block.type !== 'tool_result') return block
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        if (!text || text.length <= MIN_PRUNE_CHARS) return block
        return { ...block, content: PRUNED_PLACEHOLDER }
      })
      result[i] = { ...msg, content: newContent }
      pruned++
    }
    return [result, pruned]
  }

  /**
   * 移除孤立的 tool_use / tool_result（压缩后 ID 不匹配的消息）
   */
  private _cleanOrphanedToolPairs(messages: Message[]): Message[] {
    const toolUseIds = new Set<string>()
    const toolResultIds = new Set<string>()

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id)
        if (block.type === 'tool_result' && block.tool_use_id) toolResultIds.add(block.tool_use_id)
      }
    }

    return messages.filter((msg) => {
      if (!Array.isArray(msg.content)) return true
      const blocks = msg.content as ContentBlock[]
      // 消息中有孤立 tool_use（没有对应 result）→ 移除
      const hasOrphanUse = blocks.some(
        (b) => b.type === 'tool_use' && b.id && !toolResultIds.has(b.id),
      )
      // 消息中有孤立 tool_result（没有对应 use）→ 移除
      const hasOrphanResult = blocks.some(
        (b) => b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id),
      )
      return !hasOrphanUse && !hasOrphanResult
    })
  }

  /**
   * 生成结构化摘要（同步版本，基于关键内容提取）
   * 异步版本（带 LLM）在 compactAsync 中使用
   */
  private _createStructuredSummary(messages: Message[]): string | null {
    if (messages.length === 0) return null

    const parts: string[] = ['[以下为已压缩的历史摘要]']

    const userMsgs = messages.filter((m) => m.role === 'user')
    const asstMsgs = messages.filter((m) => m.role === 'assistant')

    if (userMsgs.length > 0) {
      const first = userMsgs[0]
      const text =
        typeof first.content === 'string'
          ? first.content
          : (first.content as ContentBlock[]).find((b) => b.type === 'text')?.text || ''
      if (text) parts.push(`## 主要请求\n${text.slice(0, 300)}`)
    }

    if (asstMsgs.length > 0) {
      const last = asstMsgs[asstMsgs.length - 1]
      const text =
        typeof last.content === 'string'
          ? last.content
          : (last.content as ContentBlock[]).find((b) => b.type === 'text')?.text || ''
      if (text) parts.push(`## 最终响应\n${text.slice(0, 300)}`)
    }

    // 工具调用摘要
    const toolCalls = messages
      .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
      .flatMap((m) => (m.content as ContentBlock[]).filter((b) => b.type === 'tool_use'))
      .map((b) => b.name)
      .filter(Boolean)
    if (toolCalls.length > 0) {
      parts.push(`## 执行的工具\n${[...new Set(toolCalls)].join(', ')}`)
    }

    return parts.join('\n\n')
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
   * 导入历史（安全版：解析失败不丢失原有消息）
   */
  import(data: string): void {
    let parsed: any[]
    try {
      parsed = JSON.parse(data)
    } catch (error) {
      logger.error('导入消息历史失败（JSON 解析错误），保留原有历史:', error)
      return // 不清空已有消息，保留现状
    }
    if (!Array.isArray(parsed)) {
      logger.error('导入消息历史失败（数据格式不是数组），保留原有历史')
      return
    }
    this.clear()
    let imported = 0
    for (const msg of parsed) {
      try {
        this.addMessage({
          ...msg,
          timestamp: msg.timestamp ? new Date(msg.timestamp) : undefined,
        })
        imported++
      } catch (msgError) {
        logger.warn(`跳过损坏的消息 (${imported}):`, msgError)
      }
    }
    logger.info(`导入 ${imported} 条消息`)
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
