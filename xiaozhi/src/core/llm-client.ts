// src/core/llm-client.ts
// 统一 LLM 客户端 - 使用 @anthropic-ai/sdk 连接智谱 GLM

import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '../utils/logger'
import { GLM_CONFIG, DEFAULT_MODEL, resolveModelName } from './model-config'
import { modelCapabilitiesManager, type ModelCapability } from './model-capabilities'
import { analyzeTaskComplexity, parseThinkingOutput, type TaskComplexity } from './glm-extensions'
import { MessageHistoryManager, type Message, toApiMessages } from './message-history'
import { applyPromptCaching } from './prompt-cache'

const logger = createLogger('llm-client')

/**
 * 聊天参数
 */
export interface ChatParams {
  model: string
  maxTokens: number
  messages: Message[]
  system?: string
  tools?: Anthropic.Tool[]
  stream?: boolean
}

/**
 * 聊天事件
 */
export type ChatEvent =
  | { type: 'content_start' }
  | { type: 'content_delta'; text: string }
  | { type: 'content_end' }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_end' }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; error: Error }

/**
 * LLM 客户端配置
 */
export interface LLMClientConfig {
  apiKey?: string
  baseURL?: string
  defaultModel?: string
  defaultMaxTokens?: number
  timeout?: number
}

/**
 * 统一 LLM 客户端
 */
export class LLMClient {
  private client: Anthropic
  private defaultModel: string
  private defaultMaxTokens: number
  private historyManager: MessageHistoryManager

  constructor(config: LLMClientConfig = {}) {
    const apiKey = config.apiKey || GLM_CONFIG.apiKey
    const baseURL = config.baseURL || GLM_CONFIG.baseURL

    if (!apiKey) {
      throw new Error('ZHIPU_API_KEY 环境变量未设置')
    }

    this.client = new Anthropic({
      apiKey,
      baseURL,
    })

    this.defaultModel = config.defaultModel || DEFAULT_MODEL
    this.defaultMaxTokens = config.defaultMaxTokens || 16000
    this.historyManager = new MessageHistoryManager()

    logger.info(`LLM 客户端已初始化，连接到 ${baseURL}`)
  }

  /**
   * 流式对话
   */
  async *chat(params: ChatParams): AsyncGenerator<ChatEvent> {
    const modelId = resolveModelName(params.model)
    const capability = modelCapabilitiesManager.resolveModel(modelId)

    // 分析任务复杂度
    const lastUserMessage = params.messages.filter((m) => m.role === 'user').pop()
    const userContent =
      typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : lastUserMessage?.content[0]?.text || ''

    const complexity = analyzeTaskComplexity(userContent, params.tools || [])

    logger.debug(`开始流式对话，模型: ${modelId}`)

    try {
      // 构建请求参数
      let apiMessages = toApiMessages(params.messages) as Anthropic.MessageParam[]

      // T2: Prompt Caching（仅 Anthropic 原生端点支持，GLM 不支持）
      if (capability.supportsPromptCaching) {
        apiMessages = applyPromptCaching(
          apiMessages as unknown as Record<string, unknown>[],
        ) as unknown as Anthropic.MessageParam[]
        logger.debug('已应用 Prompt Caching 断点')
      }

      const requestParams: Anthropic.MessageCreateParams = {
        model: modelId,
        max_tokens: Math.min(params.maxTokens || this.defaultMaxTokens, capability.maxOutput),
        messages: apiMessages,
        stream: true,
      }

      if (params.system) {
        requestParams.system = params.system
      }

      if (params.tools && params.tools.length > 0) {
        requestParams.tools = params.tools
      }

      // 添加 GLM 特殊参数（如果支持 thinking mode）
      if (capability.supportsThinking && (complexity.level === 'complex' || complexity.level === 'research')) {
        (requestParams as unknown as Record<string, unknown>).enable_thinking = true
        logger.info('启用 GLM-5 thinking mode 用于复杂任务')
      }

      const stream = this.client.messages.stream(requestParams)

      let thinkingContent = ''
      let currentToolUse: { id: string; name: string; input: string } | null = null

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'thinking') {
              yield { type: 'thinking_start' }
            } else if (event.content_block.type === 'text') {
              yield { type: 'content_start' }
            } else if (event.content_block.type === 'tool_use') {
              currentToolUse = {
                id: event.content_block.id,
                name: event.content_block.name,
                input: '',
              }
            }
            break

          case 'content_block_delta':
            if (event.delta.type === 'thinking_delta') {
              thinkingContent += event.delta.thinking || ''
              yield { type: 'thinking_delta', text: event.delta.thinking || '' }
            } else if (event.delta.type === 'text_delta') {
              yield { type: 'content_delta', text: event.delta.text }
            } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.input += event.delta.partial_json || ''
            }
            break

          case 'content_block_stop':
            if (currentToolUse) {
              try {
                const input = JSON.parse(currentToolUse.input)
                yield {
                  type: 'tool_use',
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input,
                }
              } catch {
                logger.warn('工具调用输入解析失败')
              }
              currentToolUse = null
            } else if (thinkingContent) {
              yield { type: 'thinking_end' }
              thinkingContent = ''
            } else {
              yield { type: 'content_end' }
            }
            break

          case 'message_stop':
            {
              const finalMessage = await stream.finalMessage()
              yield {
                type: 'done',
                usage: {
                  inputTokens: finalMessage.usage.input_tokens,
                  outputTokens: finalMessage.usage.output_tokens,
                },
              }
            }
            break
        }
      }
    } catch (error) {
      logger.error('流式对话错误:', error)
      yield { type: 'error', error: error as Error }
    }
  }

  /**
   * 非流式对话（简单场景）
   */
  async chatSync(params: ChatParams): Promise<{
    content: string
    thinking: string | null
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
    usage: { inputTokens: number; outputTokens: number }
  }> {
    const modelId = resolveModelName(params.model)
    const capability = modelCapabilitiesManager.resolveModel(modelId)

    // 分析任务复杂度
    const lastUserMessage = params.messages.filter((m) => m.role === 'user').pop()
    const userContent =
      typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content
        : lastUserMessage?.content[0]?.text || ''

    const complexity = analyzeTaskComplexity(userContent, params.tools || [])

    logger.debug(`开始同步对话，模型: ${modelId}`)

    // 构建请求参数
    let apiMessages = toApiMessages(params.messages) as Anthropic.MessageParam[]

    // T2: Prompt Caching（仅 Anthropic 原生端点支持，GLM 不支持）
    if (capability.supportsPromptCaching) {
      apiMessages = applyPromptCaching(
        apiMessages as unknown as Record<string, unknown>[],
      ) as unknown as Anthropic.MessageParam[]
      logger.debug('已应用 Prompt Caching 断点（chatSync）')
    }

    const requestParams: Anthropic.MessageCreateParams = {
      model: modelId,
      max_tokens: Math.min(params.maxTokens || this.defaultMaxTokens, capability.maxOutput),
      messages: apiMessages,
    }

    if (params.system) {
      requestParams.system = params.system
    }

    if (params.tools && params.tools.length > 0) {
      requestParams.tools = params.tools
    }

    // 添加 GLM 特殊参数（如果支持 thinking mode）
    if (capability.supportsThinking && (complexity.level === 'complex' || complexity.level === 'research')) {
      (requestParams as unknown as Record<string, unknown>).enable_thinking = true
      logger.info('启用 GLM-5 thinking mode 用于复杂任务')
    }

    const response = await this.client.messages.create(requestParams)

    let content = ''
    let thinking: string | null = null
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    for (const block of response.content) {
      if (block.type === 'text') {
        // 检查是否包含 thinking 输出
        const parsed = parseThinkingOutput(block.text)
        content += parsed.response
        if (parsed.thinking) {
          thinking = parsed.thinking
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        })
      }
    }

    return {
      content,
      thinking,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  }

  /**
   * 获取历史管理器
   */
  getHistoryManager(): MessageHistoryManager {
    return this.historyManager
  }

  /**
   * 获取可用模型列表
   */
  listModels(): ModelCapability[] {
    return modelCapabilitiesManager.listAll()
  }

  /**
   * 获取模型能力
   */
  getModelCapability(modelId: string): ModelCapability | undefined {
    return modelCapabilitiesManager.getCapability(modelId)
  }
}

// 导出默认实例
let defaultClient: LLMClient | null = null

export function getLLMClient(config?: LLMClientConfig): LLMClient {
  if (!defaultClient) {
    defaultClient = new LLMClient(config)
  }
  return defaultClient
}

export function resetLLMClient(): void {
  defaultClient = null
}
