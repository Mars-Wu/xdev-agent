// src/core/auxiliary-client.ts
// 辅助 LLM 客户端 — 用于轻量任务（压缩摘要、标题生成等）
// 参考 Hermes agent/auxiliary_client.py（简化版：单模型+静默失败）

import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '../utils/logger'
import { GLM_CONFIG } from './model-config'
import { configManager } from '../config'

const logger = createLogger('aux-client')

// 默认辅助模型（免费快速）
const DEFAULT_AUX_MODEL = 'glm-4.7-flash'

export interface AuxMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AuxChatOptions {
  messages: AuxMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface AuxChatResult {
  content: string
  inputTokens: number
  outputTokens: number
}

class AuxiliaryClient {
  private client: Anthropic
  private model: string

  constructor() {
    const config = configManager.getModelConfig()
    this.model = config.auxiliaryModel ?? DEFAULT_AUX_MODEL
    this.client = new Anthropic({
      apiKey: GLM_CONFIG.apiKey,
      baseURL: GLM_CONFIG.baseURL,
    })
    logger.debug(`辅助客户端初始化: model=${this.model}`)
  }

  async chat(options: AuxChatOptions): Promise<AuxChatResult> {
    const { messages, system, maxTokens = 500, temperature = 0.3 } = options

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: maxTokens,
      messages: messages as Anthropic.MessageParam[],
    }

    if (system) {
      params.system = system
    }

    // GLM 不支持 temperature 参数，忽略（避免 API 报错）

    const response = await this.client.messages.create(params)
    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('')

    return {
      content,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }
}

// 单例（懒初始化，首次调用时读取配置）
let _instance: AuxiliaryClient | null = null

function getAuxiliaryClient(): AuxiliaryClient {
  if (!_instance) {
    _instance = new AuxiliaryClient()
  }
  return _instance
}

/**
 * 重置辅助客户端单例（配置热重载时调用）
 */
export function resetAuxiliaryClient(): void {
  _instance = null
}

/**
 * 便捷函数：单轮对话，失败静默返回 null
 * 适用于标题生成、摘要等非关键任务
 */
export async function auxChat(
  userMessage: string,
  options?: Partial<AuxChatOptions>,
): Promise<string | null> {
  try {
    const result = await getAuxiliaryClient().chat({
      messages: [{ role: 'user', content: userMessage }],
      ...options,
    })
    return result.content
  } catch (error: any) {
    logger.debug(`辅助客户端调用失败（静默忽略）: ${error.message}`)
    return null
  }
}

/**
 * 带完整 messages 的对话，失败静默返回 null
 */
export async function auxChatMessages(options: AuxChatOptions): Promise<string | null> {
  try {
    const result = await getAuxiliaryClient().chat(options)
    return result.content
  } catch (error: any) {
    logger.debug(`辅助客户端对话失败（静默忽略）: ${error.message}`)
    return null
  }
}
