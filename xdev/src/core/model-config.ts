// src/core/model-config.ts
// Provider-aware text and vision model configuration

import {
  DEFAULT_MAIN_MODEL,
  getModelCatalogEntry,
  listTextCatalogModels,
  resolveCatalogModelId,
  type ModelPreset,
  type ModelProvider,
} from './model-catalog'

export interface ModelConfig {
  id: string
  name: string
  provider: ModelProvider
  contextWindow: number
  maxOutput: number
  costPerMtok: {
    input: number
    output: number
  }
  aliases: string[]
}

export interface TextApiConfig {
  provider: ModelProvider
  baseURL: string
  apiKey: string
}

export interface VisionApiConfig {
  provider: 'glm'
  endpoint: string
  apiKey: string
}

export interface ResolveModelOptions {
  fallback?: string
  provider?: ModelProvider
}

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

const GLM_TEXT_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
const DEEPSEEK_TEXT_BASE_URL = 'https://api.deepseek.com/anthropic'
const GLM_VISION_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'

export const DEFAULT_MODEL = DEFAULT_MAIN_MODEL

export function inferProviderFromModel(modelId?: string): ModelProvider {
  if (!modelId) return 'glm'
  const entry = getModelCatalogEntry(modelId)
  if (entry?.kind === 'text') return entry.provider

  const resolved = resolveCatalogModelId(modelId, {
    kind: 'text',
    transport: 'anthropic-messages',
    fallback: DEFAULT_MODEL,
  })
  const resolvedEntry = getModelCatalogEntry(resolved)
  return resolvedEntry?.provider ?? 'glm'
}

export function getConfiguredTextProvider(defaultModel?: string): ModelProvider {
  const configured = process.env.XDEV_LLM_PROVIDER?.trim().toLowerCase()
  if (configured === 'glm' || configured === 'deepseek') {
    return configured
  }

  if (process.env.XDEV_MODEL_PRESET) {
    return inferProviderFromPreset(process.env.XDEV_MODEL_PRESET as ModelPreset)
  }

  if (defaultModel) {
    return inferProviderFromModel(defaultModel)
  }

  if (process.env.DEEPSEEK_API_KEY && !process.env.ZHIPU_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return 'deepseek'
  }

  return 'glm'
}

function inferProviderFromPreset(preset: ModelPreset): ModelProvider {
  return preset.startsWith('deepseek-') ? 'deepseek' : 'glm'
}

export function resolveTextApiConfig(options: {
  provider?: ModelProvider
  model?: string
  apiKey?: string
  baseURL?: string
} = {}): TextApiConfig {
  const provider = options.provider || getConfiguredTextProvider(options.model)
  if (provider === 'deepseek') {
    return {
      provider,
      baseURL: options.baseURL || process.env.XDEV_LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || DEEPSEEK_TEXT_BASE_URL,
      apiKey: options.apiKey || process.env.XDEV_LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    }
  }

  return {
    provider: 'glm',
    baseURL: options.baseURL
      || process.env.XDEV_LLM_BASE_URL
      || process.env.ZHIPU_API_BASE_URL
      || process.env.GLM_BASE_URL
      || process.env.ANTHROPIC_BASE_URL
      || GLM_TEXT_BASE_URL,
    apiKey: options.apiKey
      || process.env.XDEV_LLM_API_KEY
      || process.env.ZHIPU_API_KEY
      || process.env.ANTHROPIC_AUTH_TOKEN
      || '',
  }
}

export function resolveVisionApiConfig(): VisionApiConfig {
  return {
    provider: 'glm',
    endpoint: process.env.XDEV_VISION_BASE_URL || GLM_VISION_ENDPOINT,
    apiKey: process.env.XDEV_VISION_API_KEY
      || process.env.ZHIPU_API_KEY
      || process.env.ANTHROPIC_AUTH_TOKEN
      || '',
  }
}

export const GLM_CONFIG = resolveTextApiConfig({ provider: 'glm' })

export function getModelConfig(modelId: string, options: ResolveModelOptions = {}): ModelConfig | undefined {
  const resolvedId = resolveModelName(modelId, options)
  return AVAILABLE_MODELS.find((m) => m.id === resolvedId)
}

export function resolveModelName(input: string, options: ResolveModelOptions = {}): string {
  return resolveCatalogModelId(input, {
    kind: 'text',
    transport: 'anthropic-messages',
    provider: options.provider,
    fallback: options.fallback || DEFAULT_MODEL,
  })
}
