// src/core/index.ts
// 核心模块导出

// LLM 客户端
export { LLMClient, getLLMClient, resetLLMClient, type ChatParams, type ChatEvent, type LLMClientConfig } from './llm-client'

// 模型配置
export {
  AVAILABLE_MODELS,
  GLM_CONFIG,
  DEFAULT_MODEL,
  getModelConfig,
  resolveModelName,
  type ModelConfig,
} from './model-config'

// 模型能力
export {
  ModelCapabilitiesManager,
  modelCapabilitiesManager,
  type ModelCapability,
} from './model-capabilities'

// 模型选择
export {
  IntelligentModelSelector,
  modelSelector,
  type ModelSelectorConfig,
} from './model-selector'

// GLM 扩展
export {
  analyzeTaskComplexity,
  buildGLMRequest,
  parseThinkingOutput,
  selectBestModel,
  type TaskComplexity,
  type GLMSpecialParams,
} from './glm-extensions'

// 消息历史
export {
  MessageHistoryManager,
  toApiMessages,
  type Message,
  type MessageRole,
  type ContentBlock,
  type MessageHistoryConfig,
} from './message-history'

// 错误处理
export {
  APIError,
  APIErrorType,
  APIErrorHandler,
  getErrorHandler,
  resetErrorHandler,
} from './error-handler'

// 重试工具
export {
  withRetry,
  withTimeout,
  withTimeoutAndRetry,
  type RetryOptions,
} from './retry'
