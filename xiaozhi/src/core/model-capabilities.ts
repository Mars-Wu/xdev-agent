// src/core/model-capabilities.ts
// 动态模型能力管理 - 借鉴 originClaw 的模型管理系统

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createLogger } from '../utils/logger'
import { AVAILABLE_MODELS, type ModelConfig } from './model-config'

const logger = createLogger('model-capabilities')

/**
 * 模型能力接口
 */
export interface ModelCapability {
  id: string
  name: string
  provider: 'glm'

  // 上下文限制
  contextWindow: number // 最大输入 tokens
  maxOutput: number // 最大输出 tokens

  // 能力标志
  supportsThinking: boolean // 支持 thinking mode
  supportsVision: boolean // 支持图像输入
  supportsTools: boolean // 支持工具调用
  supportsPromptCaching: boolean // 支持 Anthropic prompt caching（GLM 不支持）
  maxToolCalls: number // 单次最大工具调用数

  // 成本
  costPerMtok: {
    input: number
    output: number
  }

  // 是否免费
  isFree: boolean

  // 别名
  aliases: string[]
}

/**
 * 默认能力配置
 */
const DEFAULT_CAPABILITIES: ModelCapability[] = [
  // 付费主力模型
  {
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'glm',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 700,
    costPerMtok: { input: 1, output: 1 },
    isFree: false,
    aliases: ['glm5', 'g5', 'glm-5'],
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'glm',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 700,
    costPerMtok: { input: 1, output: 1 },
    isFree: false,
    aliases: ['turbo', 'g5t', 'glm-5-turbo'],
  },
  // 免费模型
  {
    id: 'glm-4.7-flash',
    name: 'GLM-4.7-Flash',
    provider: 'glm',
    contextWindow: 128_000,
    maxOutput: 65_536,
    supportsThinking: true,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 128,
    costPerMtok: { input: 0, output: 0 },
    isFree: true,
    aliases: ['4.7-flash', 'g4.7f', 'flash'],
  },
  {
    id: 'glm-4-flash',
    name: 'GLM-4-Flash',
    provider: 'glm',
    contextWindow: 128_000,
    maxOutput: 4096,
    supportsThinking: false,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 64,
    costPerMtok: { input: 0, output: 0 },
    isFree: true,
    aliases: ['4-flash', 'g4f', 'glm-4-flash-250414'],
  },
  {
    id: 'glm-4v-flash',
    name: 'GLM-4V-Flash',
    provider: 'glm',
    contextWindow: 8192,
    maxOutput: 1024,
    supportsThinking: false,
    supportsVision: true,
    supportsTools: false,
    supportsPromptCaching: false,
    maxToolCalls: 0,
    costPerMtok: { input: 0, output: 0 },
    isFree: true,
    aliases: ['4v-flash', 'g4vf', 'v-flash', 'vision-flash'],
  },
]

/**
 * 能力缓存路径
 */
const CAPABILITIES_CACHE_PATH = path.join(
  os.homedir(),
  '.xiaozhi',
  'cache',
  'model-capabilities.json',
)

/**
 * 模型能力管理器
 */
export class ModelCapabilitiesManager {
  private capabilities: Map<string, ModelCapability> = new Map()
  private aliasMap: Map<string, string> = new Map()
  private lastFetch: Date | null = null
  private cacheTTL: number = 24 * 60 * 60 * 1000 // 24小时

  constructor() {
    this.loadDefaults()
    this.loadFromCache().catch(() => {
      // 缓存加载失败，使用默认配置
    })
  }

  /**
   * 加载默认配置
   */
  private loadDefaults(): void {
    for (const cap of DEFAULT_CAPABILITIES) {
      this.capabilities.set(cap.id, cap)
      for (const alias of cap.aliases) {
        this.aliasMap.set(alias.toLowerCase(), cap.id)
      }
    }
    logger.info('使用默认模型能力配置')
  }

  /**
   * 从缓存加载能力配置
   */
  private async loadFromCache(): Promise<void> {
    try {
      const cacheContent = await fs.readFile(CAPABILITIES_CACHE_PATH, 'utf-8')
      const cached = JSON.parse(cacheContent)
      this.lastFetch = new Date(cached.timestamp)

      // 检查缓存是否过期
      if (Date.now() - this.lastFetch.getTime() < this.cacheTTL) {
        for (const cap of cached.capabilities) {
          this.capabilities.set(cap.id, cap)
          for (const alias of cap.aliases) {
            this.aliasMap.set(alias.toLowerCase(), cap.id)
          }
        }
        logger.info(`从缓存加载 ${this.capabilities.size} 个模型能力`)
      }
    } catch {
      // 缓存不存在或无效，使用默认配置
    }
  }

  /**
   * 保存能力配置到缓存
   */
  private async saveToCache(): Promise<void> {
    try {
      const cacheDir = path.dirname(CAPABILITIES_CACHE_PATH)
      await fs.mkdir(cacheDir, { recursive: true })

      const cacheData = {
        timestamp: new Date().toISOString(),
        capabilities: Array.from(this.capabilities.values()),
      }

      await fs.writeFile(CAPABILITIES_CACHE_PATH, JSON.stringify(cacheData, null, 2))
      logger.debug('模型能力缓存已保存')
    } catch (error) {
      logger.warn('保存模型能力缓存失败:', error)
    }
  }

  /**
   * 从 API 刷新能力配置
   * 注意：GLM API 暂不支持能力查询，使用内置配置
   */
  async refreshFromAPI(): Promise<void> {
    logger.info('GLM API 暂不支持能力查询，使用内置配置')
    await this.saveToCache()
  }

  /**
   * 解析模型名称（支持别名）
   */
  resolveModel(input: string): ModelCapability {
    // 先尝试完整 ID
    let capability = this.capabilities.get(input)
    if (capability) return capability

    // 尝试别名
    const canonicalId = this.aliasMap.get(input.toLowerCase())
    if (canonicalId) {
      capability = this.capabilities.get(canonicalId)
      if (capability) return capability
    }

    // 模糊匹配
    const fuzzyMatch = this.fuzzyMatch(input)
    if (fuzzyMatch) return fuzzyMatch

    // 未找到，返回默认
    logger.warn(`Unknown model: ${input}, using default: glm-5`)
    return this.capabilities.get('glm-5')!
  }

  /**
   * 模糊匹配模型名称
   */
  private fuzzyMatch(input: string): ModelCapability | null {
    const lower = input.toLowerCase()

    // glm-5 / glm5 -> glm-5
    if (lower.includes('glm') && lower.includes('5')) {
      if (lower.includes('turbo')) {
        return this.capabilities.get('glm-5-turbo') || null
      }
      return this.capabilities.get('glm-5') || null
    }

    // glm-4.7-flash / 4.7-flash -> glm-4.7-flash
    if ((lower.includes('4.7') || lower.includes('47')) && lower.includes('flash')) {
      return this.capabilities.get('glm-4.7-flash') || null
    }

    // glm-4v-flash / 4v-flash / vision-flash -> glm-4v-flash
    if ((lower.includes('4v') || lower.includes('vision')) && lower.includes('flash')) {
      return this.capabilities.get('glm-4v-flash') || null
    }

    // glm-4-flash / 4-flash -> glm-4-flash
    if (lower.includes('4') && lower.includes('flash') && !lower.includes('4.') && !lower.includes('4v')) {
      return this.capabilities.get('glm-4-flash') || null
    }

    return null
  }

  /**
   * 获取所有模型能力
   */
  listAll(): ModelCapability[] {
    return Array.from(this.capabilities.values())
  }

  /**
   * 获取免费模型列表
   */
  listFree(): ModelCapability[] {
    return Array.from(this.capabilities.values()).filter(cap => cap.isFree)
  }

  /**
   * 获取付费模型列表
   */
  listPaid(): ModelCapability[] {
    return Array.from(this.capabilities.values()).filter(cap => !cap.isFree)
  }

  /**
   * 获取模型能力
   */
  getCapability(modelId: string): ModelCapability | undefined {
    return this.capabilities.get(modelId)
  }

  /**
   * 检查模型是否支持某能力
   */
  hasCapability(modelId: string, capability: keyof ModelCapability): boolean {
    const cap = this.resolveModel(modelId)
    if (!cap) return false

    const value = cap[capability]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value > 0

    return false
  }

  /**
   * 获取适合特定任务的免费模型
   */
  getFreeModelForTask(task: 'translation' | 'summarization' | 'code_review' | 'vision'): ModelCapability | null {
    const freeModels = this.listFree()

    switch (task) {
      case 'vision':
        return freeModels.find(m => m.supportsVision) || null
      case 'code_review':
        return freeModels.find(m => m.supportsThinking && m.supportsTools) || null
      case 'translation':
      case 'summarization':
        return freeModels.find(m => !m.supportsVision && m.supportsTools) || null
      default:
        return freeModels[0] || null
    }
  }
}

// 导出单例
export const modelCapabilitiesManager = new ModelCapabilitiesManager()
