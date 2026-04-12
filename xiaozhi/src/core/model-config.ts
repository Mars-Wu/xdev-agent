// src/core/model-config.ts
// GLM 模型配置 - 仅支持智谱 GLM-5 系列

/**
 * 模型配置接口
 */
export interface ModelConfig {
  id: string
  name: string
  provider: 'glm'
  contextWindow: number
  maxOutput: number
  costPerMtok: {
    input: number
    output: number
  }
  aliases: string[]
}

/**
 * 可用模型列表
 */
export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: 'glm-4.7-flash',
    name: 'GLM-4.7-Flash',
    provider: 'glm',
    contextWindow: 200_000,
    maxOutput: 128_000,
    costPerMtok: { input: 0, output: 0 }, // 免费模型，30B SOTA，Agentic 优化
    aliases: ['flash', 'g4f', 'glm-4-flash', 'glm-4.7-flash'],
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'glm',
    contextWindow: 200_000, // 200K 上下文
    maxOutput: 128_000, // 128K 输出
    costPerMtok: { input: 1, output: 1 }, // 编程计划价格
    aliases: ['glm5', 'g5', 'glm-5'],
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'glm',
    contextWindow: 200_000, // 200K 上下文
    maxOutput: 128_000, // 128K 输出
    costPerMtok: { input: 1, output: 1 }, // 龙虾增强基座，任务专项优化
    aliases: ['turbo', 'g5t', 'glm-5-turbo'],
  },
]

/**
 * GLM API 配置
 * 支持 ZHIPU_API_KEY 或 ANTHROPIC_AUTH_TOKEN 环境变量
 */
export const GLM_CONFIG = {
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://open.bigmodel.cn/api/anthropic',
  apiKey: process.env.ZHIPU_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '',
}

/**
 * 默认模型
 */
export const DEFAULT_MODEL = 'glm-5-turbo'

/**
 * 获取模型配置
 */
export function getModelConfig(modelId: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find(
    (m) => m.id === modelId || m.aliases.includes(modelId.toLowerCase()),
  )
}

/**
 * 解析模型名称（支持别名）
 */
export function resolveModelName(input: string): string {
  // 先尝试完整 ID
  const directMatch = AVAILABLE_MODELS.find((m) => m.id === input)
  if (directMatch) return directMatch.id

  // 尝试别名
  const aliasMatch = AVAILABLE_MODELS.find((m) =>
    m.aliases.includes(input.toLowerCase()),
  )
  if (aliasMatch) return aliasMatch.id

  // 模糊匹配
  const lower = input.toLowerCase()
  if (lower.includes('flash') || (lower.includes('glm') && lower.includes('4'))) {
    return 'glm-4.7-flash'
  }
  if (lower.includes('glm') && lower.includes('5')) {
    if (lower.includes('turbo')) {
      return 'glm-5-turbo'
    }
    return 'glm-5'
  }

  // 未找到，返回默认
  return DEFAULT_MODEL
}
