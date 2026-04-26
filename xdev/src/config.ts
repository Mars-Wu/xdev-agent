// src/config.ts
// 统一配置管理 - 艾克斯独立配置
// 配置目录: ~/.xdev/

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from './utils/logger';
import {
  DEFAULT_CODER_MODEL,
  DEFAULT_FAST_MODEL,
  DEFAULT_MAIN_MODEL,
} from './core/model-catalog';

const logger = createLogger('config');

// ==================== 配置接口定义 ====================

/**
 * 模型配置
 *
 * 流水线各阶段使用不同模型：
 *   defaultModel   — Stage 2 主 Agent（工具调用 + 长链路执行）
 *   routerModel    — Stage 1 话题路由器（单次 JSON 分类）
 *   selectorModel  — Stage 2.5 回复选择器（选最佳候选段）
 *   backgroundModel— Background Pass（异步记忆提取/话题摘要）
  *   coderModel     — 编程子 Agent（GLM-5，当前 code plan 下更稳）
 *
 * 可在 ~/.xdev/config.json 的 "model" 字段中覆盖，
 * 也可通过环境变量 XDEV_MODEL / XDEV_ROUTER_MODEL /
 * XDEV_SELECTOR_MODEL / XDEV_BACKGROUND_MODEL / XDEV_CODER_MODEL 覆盖。
 */
export interface ModelConfig {
  /** 主 Agent 模型（Stage 2）*/
  defaultModel: string;
  /** 话题路由器模型（Stage 1）*/
  routerModel: string;
  /** 回复选择器模型（Stage 2.5）*/
  selectorModel: string;
  /** 后台记忆/摘要模型（Background Pass）*/
  backgroundModel: string;
  /** 编程子 Agent 模型（GLM-5，偏向复杂编码任务）*/
  coderModel: string;
  /** 辅助任务模型（上下文压缩摘要、标题生成、路由分类，使用廉价快速模型）*/
  auxiliaryModel?: string;
  fallbackModel?: string;
  maxTokens?: number;
}

/**
 * 超时配置
 */
export interface TimeoutConfig {
  apiTimeout: number;       // API 请求超时（毫秒）
  expertTimeout: number;    // 专家任务超时（毫秒）
  queueTimeout: number;     // 队列等待超时（毫秒）
  healthCheckInterval: number; // 健康检查间隔（毫秒）
}

/**
 * 队列配置
 */
export interface QueueConfig {
  maxSize: number;
  fullBehavior: 'reject' | 'drop_oldest' | 'drop_newest';
  maxRetries: number;
  retryBaseDelay: number;
}

/**
 * 专家系统配置
 */
export interface ExpertConfig {
  maxConcurrent: number;
  preventRecursion: boolean;
  sessionRetentionDays: number;
}

/**
 * 安全配置
 */
export interface SecurityConfig {
  apiToken: string;
  tokenExpiryHours: number;
  allowedWorkDirs: string[];
}

/**
 * 日志配置
 */
export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  maxFileSize: number;
  maxFiles: number;
}

/**
 * 会话上下文配置
 */
export interface SessionContextConfig {
  // 是否启用自动压缩
  autoCompact: boolean;
  // 压缩阈值（剩余空间比例，0-1）
  compactThreshold: number;
  // 最大上下文 token 数
  maxContextTokens: number;
  // 保留最近 N 条消息
  preserveRecent: number;
  // 压缩策略
  compactStrategy: 'sliding' | 'summary' | 'priority';
}

/**
 * 语言偏好配置
 */
export interface LanguageConfig {
  // 默认语言
  default: '中文' | 'English' | '日本語';
  // 强制使用默认语言
  enforce: boolean;
}

/**
 * 记忆系统配置
 */
export interface MemoryConfig {
  // 是否启用记忆
  enabled: boolean;
  // 最大记忆条目数
  maxEntries: number;
  // 最大文件大小（字节）
  maxFileSize: number;
  // 相关性阈值（0-1）
  relevanceThreshold: number;
  // 是否启用记忆 Lint（定期健康检查）
  lintEnabled: boolean;
  // Lint 间隔天数（默认 7 天）
  lintIntervalDays: number;
}

/**
 * 完整配置
 */
export interface XdevConfig {
  model: ModelConfig;
  timeout: TimeoutConfig;
  queue: QueueConfig;
  expert: ExpertConfig;
  security: SecurityConfig;
  log: LogConfig;
  sessionContext: SessionContextConfig;
  language: LanguageConfig;
  memory: MemoryConfig;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: XdevConfig = {
  model: {
    defaultModel:    DEFAULT_MAIN_MODEL, // 主 Agent：OpenClaw/龙虾场景专项优化
    routerModel:     DEFAULT_FAST_MODEL, // 话题路由：免费，单次 JSON，指令遵循强
    selectorModel:   DEFAULT_FAST_MODEL, // 回复选择：免费，极简任务
    backgroundModel: DEFAULT_FAST_MODEL, // 后台记忆：异步，免费够用
    coderModel:      DEFAULT_CODER_MODEL, // 编程子 Agent：code plan 下实测更稳，当前账号会映射到旗舰 coding 模型
  },
  timeout: {
    apiTimeout: 120000,      // 2 分钟
    expertTimeout: 1800000,  // 30 分钟
    queueTimeout: 60000,     // 1 分钟
    healthCheckInterval: 60000, // 1 分钟
  },
  queue: {
    maxSize: 100,
    fullBehavior: 'drop_oldest',
    maxRetries: 3,
    retryBaseDelay: 1000,
  },
  expert: {
    maxConcurrent: 5,
    preventRecursion: true,
    sessionRetentionDays: 30,
  },
  security: {
    apiToken: '',
    tokenExpiryHours: 24,
    allowedWorkDirs: [],
  },
  log: {
    level: 'info',
    maxFileSize: 10 * 1024 * 1024, // 10 MB
    maxFiles: 5,
  },
  sessionContext: {
    autoCompact: true,
    compactThreshold: 0.15,        // 剩余 15% 时触发压缩
    maxContextTokens: 200000,      // GLM-5 上下文窗口
    preserveRecent: 10,            // 保留最近 10 条消息
    compactStrategy: 'priority',   // 优先级策略
  },
  language: {
    default: '中文',
    enforce: true,
  },
  memory: {
    enabled: true,
    maxEntries: 100,
    maxFileSize: 25 * 1024,        // 25KB
    relevanceThreshold: 0.5,
    lintEnabled: true,
    lintIntervalDays: 7,           // 每周健康检查一次
  },
};

// ==================== 配置管理类 ====================

/**
 * 艾克斯配置文件路径
 */
const XDEV_CONFIG_FILE = path.join(os.homedir(), '.xdev', 'config.json');

class ConfigManager {
  private config: XdevConfig;
  private configValidated: boolean = false;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * 加载配置（合并多个来源）
   * 优先级：环境变量 > ~/.xdev/config.json > 默认值
   */
  private loadConfig(): XdevConfig {
    // 1. 从艾克斯配置文件读取
    const fileConfig = this.readFileConfig();

    // 2. 从环境变量读取
    const envConfig = this.readEnvConfig();

    // 3. 合并配置
    const config = this.mergeConfig(DEFAULT_CONFIG, fileConfig, envConfig);

    logger.debug('配置加载完成');
    return config;
  }

  /**
   * 读取艾克斯配置文件
   */
  private readFileConfig(): Partial<XdevConfig> {
    try {
      if (!fs.existsSync(XDEV_CONFIG_FILE)) {
        return {};
      }
      const content = fs.readFileSync(XDEV_CONFIG_FILE, 'utf-8');
      return JSON.parse(content) as Partial<XdevConfig>;
    } catch (error) {
      logger.debug('读取 ~/.xdev/config.json 失败:', error);
      return {};
    }
  }

  /**
   * 从环境变量读取配置
   */
  private readEnvConfig(): Partial<XdevConfig> {
    const config: Partial<XdevConfig> = {};

    // 模型配置（各流水线阶段可独立覆盖）
    const modelOverride: Partial<ModelConfig> = {};
    if (process.env.XDEV_MODEL)           modelOverride.defaultModel    = process.env.XDEV_MODEL;
    if (process.env.XDEV_ROUTER_MODEL)    modelOverride.routerModel     = process.env.XDEV_ROUTER_MODEL;
    if (process.env.XDEV_SELECTOR_MODEL)  modelOverride.selectorModel   = process.env.XDEV_SELECTOR_MODEL;
    if (process.env.XDEV_BACKGROUND_MODEL) modelOverride.backgroundModel = process.env.XDEV_BACKGROUND_MODEL;
    if (process.env.XDEV_CODER_MODEL)      modelOverride.coderModel      = process.env.XDEV_CODER_MODEL;
    if (Object.keys(modelOverride).length > 0) {
      config.model = { ...DEFAULT_CONFIG.model, ...modelOverride };
    }

    // 超时配置
    const timeout: Partial<TimeoutConfig> = {};
    const apiTimeout = process.env.XDEV_TIMEOUT || process.env.XDEV_API_TIMEOUT;
    if (apiTimeout) {
      timeout.apiTimeout = parseInt(apiTimeout, 10);
    }
    const expertTimeout = process.env.XDEV_DEFAULT_TIMEOUT || process.env.XDEV_EXPERT_TIMEOUT;
    if (expertTimeout) {
      timeout.expertTimeout = parseInt(expertTimeout, 10);
    }
    if (Object.keys(timeout).length > 0) {
      config.timeout = { ...DEFAULT_CONFIG.timeout, ...timeout };
    }

    // 队列配置
    const queue: Partial<QueueConfig> = {};
    if (process.env.XDEV_QUEUE_SIZE) {
      queue.maxSize = parseInt(process.env.XDEV_QUEUE_SIZE, 10);
    }
    if (process.env.XDEV_QUEUE_BEHAVIOR) {
      const behavior = process.env.XDEV_QUEUE_BEHAVIOR;
      if (['reject', 'drop_oldest', 'drop_newest'].includes(behavior)) {
        queue.fullBehavior = behavior as QueueConfig['fullBehavior'];
      }
    }
    if (Object.keys(queue).length > 0) {
      config.queue = { ...DEFAULT_CONFIG.queue, ...queue };
    }

    // 专家配置
    if (process.env.XDEV_MAX_CONCURRENT) {
      config.expert = {
        ...DEFAULT_CONFIG.expert,
        maxConcurrent: parseInt(process.env.XDEV_MAX_CONCURRENT, 10),
      };
    }

    // 安全配置
    if (process.env.XDEV_API_TOKEN) {
      config.security = { ...DEFAULT_CONFIG.security, apiToken: process.env.XDEV_API_TOKEN };
    }

    // 日志级别
    {
      const level = process.env.XDEV_LOG_LEVEL || process.env.LOG_LEVEL;
      if (level && ['debug', 'info', 'warn', 'error'].includes(level)) {
        config.log = { ...DEFAULT_CONFIG.log, level: level as LogConfig['level'] };
      }
    }

    // 会话上下文配置
    const sessionContext: Partial<SessionContextConfig> = {};
    if (process.env.XDEV_AUTO_COMPACT === 'false') {
      sessionContext.autoCompact = false;
    }
    if (process.env.XDEV_MAX_CONTEXT_TOKENS) {
      sessionContext.maxContextTokens = parseInt(process.env.XDEV_MAX_CONTEXT_TOKENS, 10);
    }
    if (process.env.XDEV_COMPACT_THRESHOLD) {
      sessionContext.compactThreshold = parseFloat(process.env.XDEV_COMPACT_THRESHOLD);
    }
    if (process.env.XDEV_PRESERVE_RECENT) {
      sessionContext.preserveRecent = parseInt(process.env.XDEV_PRESERVE_RECENT, 10);
    }
    if (Object.keys(sessionContext).length > 0) {
      config.sessionContext = { ...DEFAULT_CONFIG.sessionContext, ...sessionContext };
    }

    return config;
  }

  /**
   * 合并配置
   */
  private mergeConfig(
    defaults: XdevConfig,
    ...sources: Partial<XdevConfig>[]
  ): XdevConfig {
    const result = { ...defaults };

    for (const source of sources) {
      for (const key of Object.keys(source) as Array<keyof XdevConfig>) {
        if (source[key] !== undefined) {
          // 类型安全地合并嵌套对象
          const sourceValue = source[key];
          const defaultValue = result[key];
          if (
            sourceValue &&
            typeof sourceValue === 'object' &&
            defaultValue &&
            typeof defaultValue === 'object'
          ) {
            (result as Record<string, unknown>)[key] = {
              ...defaultValue,
              ...sourceValue,
            };
          } else {
            (result as Record<string, unknown>)[key] = sourceValue;
          }
        }
      }
    }

    return result;
  }

  /**
   * 验证配置
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 验证超时配置
    if (this.config.timeout.apiTimeout < 1000) {
      errors.push('apiTimeout 必须至少 1000ms');
    }
    if (this.config.timeout.expertTimeout < 60000) {
      errors.push('expertTimeout 必须至少 60000ms');
    }

    // 验证队列配置
    if (this.config.queue.maxSize < 1 || this.config.queue.maxSize > 10000) {
      errors.push('queue.maxSize 必须在 1-10000 之间');
    }

    // 验证专家配置
    if (this.config.expert.maxConcurrent < 1 || this.config.expert.maxConcurrent > 100) {
      errors.push('expert.maxConcurrent 必须在 1-100 之间');
    }

    // 验证安全配置
    if (!this.config.security.apiToken) {
      logger.warn('未配置 API Token，将使用默认值');
    }

    this.configValidated = errors.length === 0;
    return { valid: errors.length === 0, errors };
  }

  /**
   * 获取完整配置
   */
  getConfig(): XdevConfig {
    return { ...this.config };
  }

  /**
   * 获取模型配置
   */
  getModelConfig(): ModelConfig {
    return { ...this.config.model };
  }

  /**
   * 获取超时配置
   */
  getTimeoutConfig(): TimeoutConfig {
    return { ...this.config.timeout };
  }

  /**
   * 获取队列配置
   */
  getQueueConfig(): QueueConfig {
    return { ...this.config.queue };
  }

  /**
   * 获取专家配置
   */
  getExpertConfig(): ExpertConfig {
    return { ...this.config.expert };
  }

  /**
   * 获取安全配置
   */
  getSecurityConfig(): SecurityConfig {
    return { ...this.config.security };
  }

  /**
   * 获取日志配置
   */
  getLogConfig(): LogConfig {
    return { ...this.config.log };
  }

  /**
   * 获取会话上下文配置
   */
  getSessionContextConfig(): SessionContextConfig {
    return { ...this.config.sessionContext };
  }

  /**
   * 获取语言配置
   */
  getLanguageConfig(): LanguageConfig {
    return { ...this.config.language };
  }

  /**
   * 获取记忆系统配置
   */
  getMemoryConfig(): MemoryConfig {
    return { ...this.config.memory };
  }

  /**
   * 重新加载配置
   */
  reload(): void {
    this.config = this.loadConfig();
    logger.info('配置已重新加载');
  }
}

// 导出单例
export const configManager = new ConfigManager();

// ==================== 便捷函数（向后兼容） ====================

/**
 * 获取默认模型
 */
export function getDefaultModel(): string {
  return configManager.getModelConfig().defaultModel;
}

/**
 * 获取 API 超时时间（毫秒）
 */
export function getApiTimeout(): number {
  return configManager.getTimeoutConfig().apiTimeout;
}

// ==================== 路径配置 ====================

/**
 * 获取艾克斯配置目录
 */
export function getXdevHome(): string {
  return process.env.XDEV_HOME || path.join(os.homedir(), '.xdev');
}

/**
 * 获取艾克斯工作目录
 */
export function getXdevWorkspace(): string {
  return path.join(getXdevHome(), 'workspace');
}

/**
 * 获取艾克斯锁文件目录
 */
export function getXdevLocksDir(): string {
  return path.join(getXdevHome(), 'locks');
}

/**
 * 获取艾克斯升级目录
 */
export function getXdevUpgradesDir(): string {
  return path.join(getXdevHome(), 'upgrades');
}

/**
 * 获取艾克斯专家目录
 */
export function getXdevExpertsDir(): string {
  return path.join(getXdevHome(), 'experts');
}

/**
 * 获取艾克斯 Workers 目录
 */
export function getXdevWorkersDir(): string {
  return path.join(getXdevHome(), 'workers');
}

/**
 * 获取艾克斯数据库路径
 */
export function getXdevDbPath(): string {
  return process.env.XDEV_DB || path.join(getXdevHome(), 'xdev.db');
}

/**
 * 获取艾克斯系统提示词文件路径
 */
export function getSystemPromptPath(): string {
  return path.join(getXdevHome(), 'system-prompt.md');
}

/**
 * 获取艾克斯项目代码目录
 */
export function getXdevProjectDir(): string {
  return process.env.XDEV_DIR || path.resolve(__dirname, '..');
}

/**
 * 获取艾克斯会话目录
 */
export function getXdevSessionsDir(): string {
  return path.join(getXdevHome(), 'sessions');
}

/**
 * 获取艾克斯记忆目录
 */
export function getXdevMemoryDir(): string {
  return path.join(getXdevHome(), 'memory');
}

/**
 * 获取艾克斯团队目录
 */
export function getXdevTeamsDir(): string {
  return path.join(getXdevHome(), 'teams');
}

/**
 * 获取艾克斯缓存目录
 */
export function getXdevCacheDir(): string {
  return path.join(getXdevHome(), 'cache');
}

/**
 * 获取艾克斯日志目录
 */
export function getXdevLogsDir(): string {
  return path.join(getXdevHome(), 'logs');
}

/**
 * 获取艾克斯配置文件路径
 */
export function getXdevConfigPath(): string {
  return path.join(getXdevHome(), 'config.json');
}

/**
 * 获取模型能力缓存路径
 */
export function getModelCapabilitiesCachePath(): string {
  return path.join(getXdevCacheDir(), 'model-capabilities.json');
}

/**
 * 统一路径配置对象
 */
export const PATHS = {
  get XDEV_HOME() {
    return getXdevHome();
  },
  get WORKSPACE() {
    return getXdevWorkspace();
  },
  get LOCKS_DIR() {
    return getXdevLocksDir();
  },
  get UPGRADES_DIR() {
    return getXdevUpgradesDir();
  },
  get EXPERTS_DIR() {
    return getXdevExpertsDir();
  },
  get WORKERS_DIR() {
    return getXdevWorkersDir();
  },
  get DB_PATH() {
    return getXdevDbPath();
  },
  get SYSTEM_PROMPT_FILE() {
    return getSystemPromptPath();
  },
  get XDEV_DIR() {
    return getXdevProjectDir();
  },
  // 新增路径
  get SESSIONS_DIR() {
    return getXdevSessionsDir();
  },
  get MEMORY_DIR() {
    return getXdevMemoryDir();
  },
  get TEAMS_DIR() {
    return getXdevTeamsDir();
  },
  get CACHE_DIR() {
    return getXdevCacheDir();
  },
  get LOGS_DIR() {
    return getXdevLogsDir();
  },
  get CONFIG_FILE() {
    return getXdevConfigPath();
  },
  get MODEL_CAPABILITIES_CACHE() {
    return getModelCapabilitiesCachePath();
  },
};
