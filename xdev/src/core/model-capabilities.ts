// src/core/model-capabilities.ts
// 动态模型能力管理 - 借鉴 originClaw 的模型管理系统

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createLogger } from '../utils/logger'
import {
  DEFAULT_MAIN_MODEL,
  listTextCatalogModels,
  resolveCatalogModelId,
  type ModelProvider,
  type TextModelCatalogEntry,
} from './model-catalog'

const logger = createLogger('model-capabilities')

/**
 * 模型能力接口
 */
export interface ModelCapability {
  id: string
  name: string
  provider: ModelProvider

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
function toCapability(entry: TextModelCatalogEntry): ModelCapability {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    contextWindow: entry.contextWindow,
    maxOutput: entry.maxOutput,
    supportsThinking: entry.supportsThinking,
    supportsVision: entry.supportsVision,
    supportsTools: entry.supportsTools,
    supportsPromptCaching: entry.supportsPromptCaching,
    maxToolCalls: entry.maxToolCalls,
    costPerMtok: entry.costPerMtok,
    isFree: entry.isFree,
    aliases: entry.aliases,
  }
}

const DEFAULT_CAPABILITIES: ModelCapability[] = listTextCatalogModels({
  transport: 'anthropic-messages',
}).map(toCapability)

/**
 * 能力缓存路径
 */
const CAPABILITIES_CACHE_PATH = path.join(
  os.homedir(),
  '.xdev',
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

    const resolvedId = resolveCatalogModelId(input, {
      kind: 'text',
      transport: 'anthropic-messages',
      fallback: DEFAULT_MAIN_MODEL,
    })
    capability = this.capabilities.get(resolvedId)
    if (capability && resolvedId !== DEFAULT_MAIN_MODEL) return capability

    // 未找到，返回默认
    logger.warn(`Unknown model: ${input}, using default: ${DEFAULT_MAIN_MODEL}`)
    return this.capabilities.get(DEFAULT_MAIN_MODEL)!
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
