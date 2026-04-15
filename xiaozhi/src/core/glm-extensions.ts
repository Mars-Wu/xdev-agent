// src/core/glm-extensions.ts
// GLM-5 特殊能力支持

import { createLogger } from '../utils/logger'
import type { ModelCapability } from './model-capabilities'

const logger = createLogger('glm-extensions')

/**
 * 任务复杂度
 */
export interface TaskComplexity {
  level: 'simple' | 'moderate' | 'complex' | 'research'
  estimatedTokens: number
  requiresVision: boolean
  requiresThinking: boolean
  toolCallCount: number
}

/**
 * GLM 特殊参数
 */
export interface GLMSpecialParams {
  // Thinking Mode - 启用深度思考
  enable_thinking?: boolean

  // 工具调用配置
  tool_choice?: {
    type: 'auto' | 'any' | 'none'
    disable_parallel_tool_calls?: boolean
  }
}

/**
 * 分析任务复杂度
 */
export function analyzeTaskComplexity(
  message: string,
  tools: unknown[] = [],
  attachments: Array<{ type: string }> = [],
): TaskComplexity {
  const text = message.toLowerCase()

  // 简单任务：短消息，无需工具
  const isSimple =
    message.length < 200 &&
    tools.length === 0 &&
    !text.includes('分析') &&
    !text.includes('设计') &&
    !text.includes('重构')

  if (isSimple) {
    return {
      level: 'simple',
      estimatedTokens: 500,
      requiresVision: false,
      requiresThinking: false,
      toolCallCount: 0,
    }
  }

  // 研究任务：需要深度分析
  const isResearch =
    text.includes('研究') ||
    text.includes('分析') ||
    text.includes('调研') ||
    text.includes('探索') ||
    text.includes('深度')

  if (isResearch) {
    return {
      level: 'research',
      estimatedTokens: 10000,
      requiresVision: attachments.some((a) => a.type === 'image'),
      requiresThinking: true,
      toolCallCount: 20,
    }
  }

  // 复杂任务：多步骤、需要思考
  const isComplex =
    text.includes('重构') ||
    text.includes('设计') ||
    text.includes('实现') ||
    text.includes('开发') ||
    tools.length > 5

  if (isComplex) {
    return {
      level: 'complex',
      estimatedTokens: 5000,
      requiresVision: attachments.some((a) => a.type === 'image'),
      requiresThinking: true,
      toolCallCount: 10,
    }
  }

  // 中等任务
  return {
    level: 'moderate',
    estimatedTokens: 2000,
    requiresVision: attachments.some((a) => a.type === 'image'),
    requiresThinking: false,
    toolCallCount: 3,
  }
}

/**
 * 构建带 thinking mode 的请求
 */
export function buildGLMRequest(
  baseParams: Record<string, unknown>,
  capability: ModelCapability,
  taskComplexity: TaskComplexity,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...baseParams }

  // 复杂任务启用 thinking mode
  if (
    capability.supportsThinking &&
    (taskComplexity.level === 'complex' || taskComplexity.level === 'research')
  ) {
    params.enable_thinking = true
    logger.info('启用 GLM-5 thinking mode 用于复杂任务')
  }

  return params
}

/**
 * 解析 thinking mode 输出
 * GLM-5 thinking mode 会在响应中包含 <think reasoning>...</think reasoning> 块
 */
export function parseThinkingOutput(content: string): {
  thinking: string | null
  response: string
} {
  const thinkMatch = content.match(/<think reasoning>([\s\S]*?)<\/think reasoning>/)
  if (thinkMatch) {
    return {
      thinking: thinkMatch[1].trim(),
      response: content.replace(/<think reasoning>[\s\S]*?<\/think reasoning>/, '').trim(),
    }
  }
  return {
    thinking: null,
    response: content,
  }
}

/**
 * 智能模型选择
 */
export function selectBestModel(
  complexity: TaskComplexity,
  capabilities: ModelCapability[],
  preference?: {
    model?: string
  },
): ModelCapability {
  // 如果用户指定了模型，优先使用
  if (preference?.model) {
    const found = capabilities.find(
      (c) => c.id === preference.model || c.aliases.includes(preference.model!.toLowerCase()),
    )
    if (found) return found
  }

  // 根据复杂度筛选
  const suitable = capabilities.filter((cap) => {
    // 上下文窗口检查
    if (cap.contextWindow < complexity.estimatedTokens) return false

    // 视觉能力检查
    if (complexity.requiresVision && !cap.supportsVision) return false

    // 工具调用数检查
    if (complexity.toolCallCount > cap.maxToolCalls) return false

    return true
  })

  if (suitable.length === 0) {
    // 没有合适的，返回默认
    return capabilities.find((c) => c.id === 'glm-5-turbo') || capabilities[0]
  }

  // 按成本效益排序
  suitable.sort((a, b) => {
    // 简单任务优先低成本
    if (complexity.level === 'simple') {
      return a.costPerMtok.input - b.costPerMtok.input
    }

    // 复杂任务优先能力（thinking mode）
    if (complexity.level === 'complex' || complexity.level === 'research') {
      if (a.supportsThinking && !b.supportsThinking) return -1
      if (!a.supportsThinking && b.supportsThinking) return 1
    }

    // 同等能力下选择低成本
    return a.costPerMtok.input - b.costPerMtok.input
  })

  return suitable[0]
}
