// src/memory/index.ts
// 记忆系统导出

// 类型定义
export {
  MemoryType,
  MemoryScope,
  MemoryCategory,
  type MemoryEntry,
  type SessionMemory,
  type SessionAction,
  type ExtractionResult,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type ExtractionTrigger,
  type MemorySystemConfig,
  type MemoryFileMetadata,
  DEFAULT_MEMORY_CONFIG,
} from './types';

// 核心管理器
export {
  MemoryManager,
  getMemoryManager,
  resetMemoryManager,
  toLegacyEntry,
  type LegacyMemoryEntry,
} from './memory-manager';

// 会话记忆
export {
  SessionMemoryManager,
  getSessionMemoryManager,
} from './session-memory';

// 记忆提取
export {
  MemoryExtractor,
  getMemoryExtractor,
} from './memory-extractor';

// 记忆检索
export {
  MemoryRetriever,
  getMemoryRetriever,
} from './memory-retriever';
