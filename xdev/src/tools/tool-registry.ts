// src/tools/tool-registry.ts
// 工具注册表 - 管理所有工具的注册和调用

import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '../utils/logger'
import {
  Tool,
  ToolDefinition,
  ToolResult,
  ToolContext,
  FullTool,
  ToolMetadata,
  ToolCategory,
} from './tool-interface'

const logger = createLogger('tool-registry')

/**
 * 工具注册表
 */
export class ToolRegistry {
  private tools: Map<string, Tool | FullTool> = new Map()
  private context: ToolContext

  constructor(context?: ToolContext) {
    this.context = context || {}
  }

  /**
   * 注册工具
   */
  register(tool: Tool | FullTool): void {
    const name = tool.definition.name
    if (this.tools.has(name)) {
      logger.warn(`工具已存在，将被覆盖: ${name}`)
    }
    this.tools.set(name, tool)
    logger.debug(`工具已注册: ${name}`)
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: (Tool | FullTool)[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /**
   * 获取工具
   */
  get(name: string): Tool | FullTool | undefined {
    return this.tools.get(name)
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * 列出所有工具
   */
  list(): (Tool | FullTool)[] {
    return Array.from(this.tools.values())
  }

  /**
   * 按类别列出工具
   */
  listByCategory(category: ToolCategory): FullTool[] {
    return Array.from(this.tools.values()).filter(
      (tool): tool is FullTool => 'metadata' in tool && tool.metadata.category === category,
    )
  }

  /**
   * 获取所有工具定义（用于 LLM）
   */
  getDefinitions(): Anthropic.Tool[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.definition.parameters,
        required: tool.definition.required || [],
      },
    }))
  }

  /**
   * 执行工具
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        success: false,
        error: `工具不存在: ${name}`,
      }
    }

    // 合并上下文
    const ctx = { ...this.context, ...context }

    // 检查危险操作
    if (tool.definition.dangerous && !ctx.allowDangerous) {
      return {
        success: false,
        error: `工具 "${name}" 是危险操作，需要确认`,
      }
    }

    // 参数验证
    if (tool.validateParams) {
      const validation = tool.validateParams(params)
      if (!validation.valid) {
        return {
          success: false,
          error: `参数验证失败: ${validation.errors?.join(', ')}`,
        }
      }
    }

    // 执行工具
    const startTime = Date.now()
    try {
      const result = await tool.execute(params, ctx)
      result.duration = Date.now() - startTime

      logger.debug(`工具执行完成: ${name} (${result.duration}ms)`)
      return result
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      logger.error(`工具执行失败: ${name} - ${errorMessage}`)
      return {
        success: false,
        error: errorMessage,
        duration,
      }
    }
  }

  /**
   * 设置默认上下文
   */
  setContext(context: Partial<ToolContext>): void {
    this.context = { ...this.context, ...context }
  }

  /**
   * 清理所有工具
   */
  async cleanup(): Promise<void> {
    for (const tool of this.tools.values()) {
      if (tool.cleanup) {
        try {
          await tool.cleanup()
        } catch (error) {
          logger.error(`工具清理失败: ${tool.definition.name}`, error)
        }
      }
    }
    this.tools.clear()
    logger.info('所有工具已清理')
  }

  /**
   * 获取工具统计
   */
  getStats(): {
    total: number
    byCategory: Record<ToolCategory, number>
    dangerous: string[]
    readOnly: string[]
  } {
    const stats = {
      total: this.tools.size,
      byCategory: {} as Record<ToolCategory, number>,
      dangerous: [] as string[],
      readOnly: [] as string[],
    }

    for (const tool of this.tools.values()) {
      // 类别统计
      if ('metadata' in tool) {
        const category = tool.metadata.category
        stats.byCategory[category] = (stats.byCategory[category] || 0) + 1
      }

      // 危险操作
      if (tool.definition.dangerous) {
        stats.dangerous.push(tool.definition.name)
      }

      // 只读操作
      if (tool.definition.readOnly) {
        stats.readOnly.push(tool.definition.name)
      }
    }

    return stats
  }
}

// 全局工具注册表
let globalRegistry: ToolRegistry | null = null

/**
 * 获取全局工具注册表
 */
export function getToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = new ToolRegistry()
  }
  return globalRegistry
}

/**
 * 重置全局工具注册表
 */
export function resetToolRegistry(): void {
  globalRegistry = null
}
