// src/core/model-config.ts
// 文本模型配置：从统一模型目录派生

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

import {
  DEFAULT_MAIN_MODEL,
  listTextCatalogModels,
  resolveCatalogModelId,
} from './model-catalog'

export const AVAILABLE_MODELS: ModelConfig[] = listTextCatalogModels({
  transport: 'anthropic-messages',
}).map((entry) => ({
  id: entry.id,
  name: entry.name,
  provider: entry.provider,
  contextWindow: entry.contextWindow,
  maxOutput: entry.maxOutput,
  costPerMtok: entry.costPerMtok,
  aliases: entry.aliases,
}))

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
export const DEFAULT_MODEL = DEFAULT_MAIN_MODEL

/**
 * 获取模型配置
 */
export function getModelConfig(modelId: string): ModelConfig | undefined {
  const resolvedId = resolveCatalogModelId(modelId, {
    kind: 'text',
    transport: 'anthropic-messages',
    fallback: DEFAULT_MODEL,
  })
  return AVAILABLE_MODELS.find((m) => m.id === resolvedId)
}

/**
 * 解析模型名称（支持别名）
 */
export function resolveModelName(input: string): string {
  return resolveCatalogModelId(input, {
    kind: 'text',
    transport: 'anthropic-messages',
    fallback: DEFAULT_MODEL,
  })
}
