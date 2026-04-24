// src/skills/types.ts
// Skill 类型定义

/**
 * Skill 参数定义
 */
export interface SkillParameter {
  /** 参数名称 */
  name: string
  /** 参数描述 */
  description?: string
  /** 参数类型 */
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  /** 是否必需 */
  required?: boolean
  /** 默认值 */
  default?: unknown
}

/**
 * Skill 定义
 */
export interface SkillDefinition {
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description?: string
  /** 版本号 */
  version?: string
  /** 作者 */
  author?: string
  /** 参数列表 */
  parameters?: SkillParameter[]
  /** 系统提示词模板 */
  systemPrompt: string
  /** 示例 */
  examples?: Array<{
    input: Record<string, unknown>
    output?: string
  }>
  /** 模型配置 */
  model?: string
  /** 温度 */
  temperature?: number
  /** 最大 token */
  maxTokens?: number
}

/**
 * Skill 文件元数据 (frontmatter)
 */
export interface SkillFrontmatter {
  name: string
  description?: string
  version?: string
  author?: string
  parameters?: SkillParameter[]
  model?: string
  temperature?: number
  maxTokens?: number
}

/**
 * Skill 执行上下文
 */
export interface SkillExecutionContext {
  skillName: string
  parameters: Record<string, unknown>
  userMessage?: string
  conversationHistory?: Array<{
    role: 'user' | 'assistant'
    content: string
  }>
  workingDirectory?: string
}

/**
 * Skill 执行结果
 */
export interface SkillExecutionResult {
  success: boolean
  content: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
  error?: string
}
