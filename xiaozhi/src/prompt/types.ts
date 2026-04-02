// src/prompt/types.ts
// Prompt 系统类型定义

/**
 * Prompt 片段
 */
export interface PromptSection {
  id: string
  title: string
  content: string
  priority: number // 越小越重要，排在前面
  required?: boolean
}

/**
 * Prompt 构建选项
 */
export interface PromptBuildOptions {
  includeMemory?: boolean
  includeTools?: boolean
  includeCapabilities?: boolean
  customSections?: PromptSection[]
  maxTokens?: number
}

/**
 * Prompt 模板
 */
export interface PromptTemplate {
  id: string
  name: string
  description: string
  basePrompt: string
  sections: PromptSection[]
}

/**
 * 记忆项
 */
export interface MemoryItem {
  key: string
  value: string
  importance: number
  timestamp: number
}
