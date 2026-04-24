// src/prompt/index.ts
// Prompt 系统导出

export {
  PromptSection,
  PromptBuildOptions,
  PromptTemplate,
  MemoryItem,
} from './types'

export {
  PromptBuilder,
  createPromptBuilder,
} from './builder'

export {
  ContextInfo,
  GitInfo,
  SystemInfo,
  getContextInfo,
  buildContextPrompt,
  getContextSummary,
} from './context'
