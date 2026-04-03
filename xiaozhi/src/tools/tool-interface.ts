// src/tools/tool-interface.ts
// 工具接口定义 - 标准化所有工具的接口

/**
 * 工具参数定义（JSON Schema 格式）
 */
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  description?: string
  enum?: string[]
  default?: unknown
  properties?: Record<string, ToolParameterSchema>
  required?: string[]
  items?: ToolParameterSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

/**
 * 工具定义
 */
export interface ToolDefinition {
  // 工具唯一标识
  name: string
  // 工具描述
  description: string
  // 参数定义（JSON Schema）
  parameters: Record<string, ToolParameterSchema>
  // 必需参数
  required?: string[]
  // 是否危险操作（需要确认）
  dangerous?: boolean
  // 是否只读操作
  readOnly?: boolean
  // 超时时间（毫秒）
  timeout?: number
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  // 是否成功
  success: boolean
  // 输出内容
  output?: string
  // 错误信息
  error?: string
  // 结构化数据
  data?: Record<string, unknown>
  // 执行时间（毫秒）
  duration?: number
}

/**
 * 工具执行上下文
 */
export interface ToolContext {
  // 会话 ID
  sessionId?: string
  // 工作目录
  workDir?: string
  // 最大超时时间
  timeout?: number
  // 是否允许危险操作
  allowDangerous?: boolean
  // 额外配置
  config?: Record<string, unknown>
}

/**
 * 工具接口 - 所有工具必须实现此接口
 */
export interface Tool {
  // 工具定义
  readonly definition: ToolDefinition
  // 执行工具
  execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>
  // 验证参数
  validateParams?(params: Record<string, unknown>): { valid: boolean; errors?: string[] }
  // 清理资源
  cleanup?(): Promise<void>
}

/**
 * 工具类别
 */
export type ToolCategory =
  | 'file' // 文件操作
  | 'shell' // Shell 命令
  | 'browser' // 浏览器自动化
  | 'network' // 网络请求
  | 'memory' // 记忆管理
  | 'system' // 系统信息
  | 'custom' // 自定义工具

/**
 * 工具元数据
 */
export interface ToolMetadata {
  category: ToolCategory
  version: string
  author?: string
  tags?: string[]
  examples?: Array<{
    description: string
    params: Record<string, unknown>
  }>
}

/**
 * 完整工具接口（包含元数据）
 */
export interface FullTool extends Tool {
  readonly metadata: ToolMetadata
}

/**
 * 创建简单工具的辅助函数
 */
export function createTool(
  definition: ToolDefinition,
  executor: (params: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>,
  metadata?: Partial<ToolMetadata>,
): Tool {
  return {
    definition,
    execute: executor,
  }
}

/**
 * 创建成功结果
 */
export function successResult(output: string, data?: Record<string, unknown>): ToolResult {
  return {
    success: true,
    output,
    data,
  }
}

/**
 * 创建失败结果
 */
export function errorResult(error: string): ToolResult {
  return {
    success: false,
    error,
  }
}
