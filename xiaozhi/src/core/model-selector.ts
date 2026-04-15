// src/core/model-selector.ts
// 智能模型选择器 - 根据任务复杂度自动选择最佳模型

import { createLogger } from '../utils/logger'
import { modelCapabilitiesManager, type ModelCapability } from './model-capabilities'
import { analyzeTaskComplexity, type TaskComplexity } from './glm-extensions'
import { DEFAULT_MAIN_MODEL } from './model-catalog'

const logger = createLogger('model-selector')

/**
 * 模型选择配置
 */
export interface ModelSelectorConfig {
  // 默认模型
  defaultModel: string
  // 允许自动切换模型
  allowAutoSwitch: boolean
  // 复杂度阈值
  complexityThresholds: {
    simple: number // < X tokens 视为简单
    moderate: number // < X tokens 视为中等
    complex: number // < X tokens 视为复杂
  }
  // 用户偏好
  preferences: {
    // 优先速度
    preferSpeed: boolean
    // 优先质量
    preferQuality: boolean
    // 最大成本（每百万 token）
    maxCostPerMtok: number
  }
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ModelSelectorConfig = {
  defaultModel: DEFAULT_MAIN_MODEL,
  allowAutoSwitch: true,
  complexityThresholds: {
    simple: 500,
    moderate: 2000,
    complex: 10000,
  },
  preferences: {
    preferSpeed: false,
    preferQuality: true,
    maxCostPerMtok: 10,
  },
}

/**
 * 智能模型选择器
 */
export class IntelligentModelSelector {
  private config: ModelSelectorConfig

  constructor(config: Partial<ModelSelectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 选择最佳模型
   */
  selectBestModel(
    message: string,
    tools: unknown[] = [],
    attachments: Array<{ type: string }> = [],
    userPreference?: {
      model?: string
    },
  ): {
    model: ModelCapability
    complexity: TaskComplexity
    reason: string
  } {
    // 分析任务复杂度
    const complexity = analyzeTaskComplexity(message, tools, attachments)

    // 如果用户指定了模型，优先使用
    if (userPreference?.model) {
      const userModel = modelCapabilitiesManager.resolveModel(userPreference.model)
      if (userModel) {
        return {
          model: userModel,
          complexity,
          reason: `用户指定模型: ${userModel.name}`,
        }
      }
    }

    // 如果不允许自动切换，使用默认模型
    if (!this.config.allowAutoSwitch) {
      const defaultModel = modelCapabilitiesManager.resolveModel(this.config.defaultModel)
      return {
        model: defaultModel,
        complexity,
        reason: `自动切换已禁用，使用默认模型: ${defaultModel.name}`,
      }
    }

    // 获取所有可用模型
    const allModels = modelCapabilitiesManager.listAll()

    // 筛选适合的模型
    const suitable = allModels.filter((cap) => {
      // 上下文窗口检查
      if (cap.contextWindow < complexity.estimatedTokens) return false

      // 视觉能力检查
      if (complexity.requiresVision && !cap.supportsVision) return false

      // 工具调用数检查
      if (complexity.toolCallCount > cap.maxToolCalls) return false

      // 成本检查
      if (cap.costPerMtok.input > this.config.preferences.maxCostPerMtok) return false

      return true
    })

    if (suitable.length === 0) {
      // 没有合适的，返回默认
      const defaultModel = modelCapabilitiesManager.resolveModel(this.config.defaultModel)
      return {
        model: defaultModel,
        complexity,
        reason: `没有合适的模型，使用默认: ${defaultModel.name}`,
      }
    }

    // 排序选择最佳
    suitable.sort((a, b) => {
      // 简单任务优先速度（低成本）
      if (complexity.level === 'simple' || this.config.preferences.preferSpeed) {
        return a.costPerMtok.input - b.costPerMtok.input
      }

      // 复杂/研究任务优先能力
      if (complexity.level === 'complex' || complexity.level === 'research') {
        // 优先 thinking mode
        if (a.supportsThinking && !b.supportsThinking) return -1
        if (!a.supportsThinking && b.supportsThinking) return 1

        // 如果偏好质量，选择能力更强的
        if (this.config.preferences.preferQuality) {
          // turbo 版本通常有更好的专项优化
          if (a.id.includes('turbo') && !b.id.includes('turbo')) return -1
          if (!a.id.includes('turbo') && b.id.includes('turbo')) return 1
        }
      }

      // 同等条件下选择低成本
      return a.costPerMtok.input - b.costPerMtok.input
    })

    const selected = suitable[0]
    let reason = `任务复杂度: ${complexity.level}`

    if (complexity.requiresThinking && selected.supportsThinking) {
      reason += ', 启用 thinking mode'
    }
    if (complexity.requiresVision && selected.supportsVision) {
      reason += ', 支持视觉'
    }

    logger.info(`模型选择: ${selected.name} (${reason})`)

    return {
      model: selected,
      complexity,
      reason,
    }
  }

  /**
   * 分析任务复杂度（公开方法）
   */
  analyzeComplexity(
    message: string,
    tools: unknown[] = [],
    attachments: Array<{ type: string }> = [],
  ): TaskComplexity {
    return analyzeTaskComplexity(message, tools, attachments)
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ModelSelectorConfig>): void {
    this.config = { ...this.config, ...config }
    logger.info('模型选择器配置已更新')
  }

  /**
   * 获取当前配置
   */
  getConfig(): ModelSelectorConfig {
    return { ...this.config }
  }

  /**
   * 获取推荐模型
   */
  getRecommendedModel(complexity: TaskComplexity): ModelCapability {
    const allModels = modelCapabilitiesManager.listAll()

    const suitable = allModels.filter((cap) => {
      if (cap.contextWindow < complexity.estimatedTokens) return false
      if (complexity.requiresVision && !cap.supportsVision) return false
      if (complexity.toolCallCount > cap.maxToolCalls) return false
      return true
    })

    if (suitable.length === 0) {
      return modelCapabilitiesManager.resolveModel(this.config.defaultModel)
    }

    // 复杂任务推荐 turbo
    if (complexity.level === 'complex' || complexity.level === 'research') {
      const turbo = suitable.find((m) => m.id.includes('turbo'))
      if (turbo) return turbo
    }

    // 简单任务推荐基础模型
    if (complexity.level === 'simple') {
      const base = suitable.find((m) => !m.id.includes('turbo'))
      if (base) return base
    }

    return suitable[0]
  }
}

// 导出默认实例
export const modelSelector = new IntelligentModelSelector()
