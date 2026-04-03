// src/config/index.ts
// 配置模块导出

// 重新导出主配置模块
export {
  XiaozhiConfig,
  ModelConfig,
  TimeoutConfig,
  QueueConfig,
  ExpertConfig,
  SecurityConfig,
  LogConfig,
  SessionContextConfig,
  LanguageConfig,
  MemoryConfig,
  configManager,
  getDefaultModel,
  getApiTimeout,
  PATHS,
  getXiaozhiHome,
  getXiaozhiWorkspace,
  getXiaozhiExpertsDir,
  getXiaozhiDbPath,
} from '../config';

// 导出验证模块
export {
  ValidationResult,
  ValidationError,
  ValidationWarning,
  validateConfig,
  formatValidationResult,
  ModelConfigSchema,
  TimeoutConfigSchema,
  QueueConfigSchema,
  SessionContextConfigSchema,
} from './schema';

// 导出热重载模块
export {
  ConfigHotReloader,
  ConfigChangeListener,
  HotReloadOptions,
  createConfigHotReloader,
} from './hot-reload';
