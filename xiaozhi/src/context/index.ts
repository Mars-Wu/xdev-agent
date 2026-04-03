// src/context/index.ts
// 上下文管理模块

export {
  ContextCompressor,
  CompressionConfig,
  CompressionResult,
  Message,
  getContextCompressor,
  resetContextCompressor,
} from './compressor';

export {
  COMPACT_PROMPT,
  PARTIAL_COMPACT_PROMPT,
  getCompactUserMessage,
} from './prompt';
