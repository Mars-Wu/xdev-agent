// src/skills/executor.ts
// Skill 执行器

import { getLLMClient } from '../core'
import { getSkillRegistry } from './registry'
import type { SkillDefinition, SkillExecutionContext, SkillExecutionResult } from './types'
import { createLogger } from '../utils/logger'
import { configManager } from '../config'

const logger = createLogger('skill-executor')

/**
 * 渲染模板
 */
function renderTemplate(
  template: string,
  params: Record<string, unknown>
): string {
  let result = template

  // 替换 {{param}} 形式的变量
  for (const [key, value] of Object.entries(params)) {
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g')
    result = result.replace(regex, String(value ?? ''))
  }

  // 处理条件块 {{#if param}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, content) => {
      const value = params[key]
      // 真值判断
      if (value && value !== false && value !== '' && value !== null) {
        return content
      }
      return ''
    }
  )

  // 处理否定条件块 {{#unless param}}...{{/unless}}
  result = result.replace(
    /\{\{#unless\s+(\w+)\}\}([\s\S]*?)\{\{\/unless\}\}/g,
    (_, key, content) => {
      const value = params[key]
      if (!value || value === false || value === '' || value === null) {
        return content
      }
      return ''
    }
  )

  return result.trim()
}

/**
 * 验证参数
 */
function validateParameters(
  skill: SkillDefinition,
  params: Record<string, unknown>
): string | null {
  if (!skill.parameters) return null

  for (const param of skill.parameters) {
    if (param.required && !(param.name in params)) {
      // 检查是否有默认值
      if (param.default === undefined) {
        return `缺少必需参数: ${param.name}`
      }
    }
  }

  return null
}

/**
 * 填充默认参数
 */
function fillDefaultParameters(
  skill: SkillDefinition,
  params: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...params }

  if (skill.parameters) {
    for (const param of skill.parameters) {
      if (!(param.name in result) && param.default !== undefined) {
        result[param.name] = param.default
      }
    }
  }

  return result
}

/**
 * Skill 执行器
 */
export class SkillExecutor {
  /**
   * 执行技能
   */
  async execute(
    skillName: string,
    params: Record<string, unknown>,
    userMessage?: string
  ): Promise<SkillExecutionResult> {
    const registry = getSkillRegistry()
    const skill = registry.get(skillName)

    if (!skill) {
      return {
        success: false,
        content: '',
        error: `技能不存在: ${skillName}`,
      }
    }

    // 填充默认参数
    const filledParams = fillDefaultParameters(skill, params)

    // 验证参数
    const validationError = validateParameters(skill, filledParams)
    if (validationError) {
      return {
        success: false,
        content: '',
        error: validationError,
      }
    }

    // 渲染系统提示词
    const systemPrompt = renderTemplate(skill.systemPrompt, filledParams)

    // 调用 LLM
    const llmClient = getLLMClient()
    const messages = userMessage
      ? [{ role: 'user' as const, content: userMessage }]
      : []

    try {
      const response = await llmClient.chatSync({
        model: skill.model || configManager.getConfig().model.defaultModel,
        maxTokens: skill.maxTokens || 16000,
        messages,
        system: systemPrompt,
      })

      logger.info(`技能执行完成: ${skillName}`)

      return {
        success: true,
        content: response.content,
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`技能执行失败: ${skillName}`, error)

      return {
        success: false,
        content: '',
        error: errorMsg,
      }
    }
  }

  /**
   * 执行技能（带历史）
   */
  async executeWithContext(
    skillName: string,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const registry = getSkillRegistry()
    const skill = registry.get(skillName)

    if (!skill) {
      return {
        success: false,
        content: '',
        error: `技能不存在: ${skillName}`,
      }
    }

    // 填充默认参数
    const filledParams = fillDefaultParameters(skill, context.parameters)

    // 验证参数
    const validationError = validateParameters(skill, filledParams)
    if (validationError) {
      return {
        success: false,
        content: '',
        error: validationError,
      }
    }

    // 渲染系统提示词
    const systemPrompt = renderTemplate(skill.systemPrompt, filledParams)

    // 构建消息
    const messages = context.conversationHistory || []
    if (context.userMessage) {
      messages.push({ role: 'user', content: context.userMessage })
    }

    // 调用 LLM
    const llmClient = getLLMClient()

    try {
      const response = await llmClient.chatSync({
        model: skill.model || configManager.getConfig().model.defaultModel,
        maxTokens: skill.maxTokens || 16000,
        messages,
        system: systemPrompt,
      })

      logger.info(`技能执行完成: ${skillName}`)

      return {
        success: true,
        content: response.content,
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`技能执行失败: ${skillName}`, error)

      return {
        success: false,
        content: '',
        error: errorMsg,
      }
    }
  }

  /**
   * 获取技能的系统提示词（用于预览）
   */
  getSystemPrompt(
    skillName: string,
    params: Record<string, unknown>
  ): string | null {
    const registry = getSkillRegistry()
    const skill = registry.get(skillName)

    if (!skill) return null

    const filledParams = fillDefaultParameters(skill, params)
    return renderTemplate(skill.systemPrompt, filledParams)
  }
}

// 单例
let executor: SkillExecutor | null = null

/**
 * 获取 Skill 执行器
 */
export function getSkillExecutor(): SkillExecutor {
  if (!executor) {
    executor = new SkillExecutor()
  }
  return executor
}

/**
 * 重置 Skill 执行器
 */
export function resetSkillExecutor(): void {
  executor = null
}
