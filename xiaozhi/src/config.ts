// src/config.ts
// 统一配置管理 - 所有配置优先从 ~/.claude/settings.json 读取
// 支持环境变量覆盖，提供配置验证

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createLogger } from './utils/logger';

const logger = createLogger('config');

// ==================== 配置接口定义 ====================

/**
 * 模型配置
 */
export interface ModelConfig {
  defaultModel: string;
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
 * 完整配置
 */
export interface XiaozhiConfig {
  model: ModelConfig;
  timeout: TimeoutConfig;
  queue: QueueConfig;
  expert: ExpertConfig;
  security: SecurityConfig;
  log: LogConfig;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: XiaozhiConfig = {
  model: {
    defaultModel: 'glm-5',
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
};

// ==================== 配置管理类 ====================

class ConfigManager {
  private config: XiaozhiConfig;
  private claudeSettingsPath: string;
  private configValidated: boolean = false;

  constructor() {
    this.claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    this.config = this.loadConfig();
  }

  /**
   * 加载配置（合并多个来源）
   */
  private loadConfig(): XiaozhiConfig {
    // 1. 从 Claude settings 读取
    const claudeSettings = this.readClaudeSettings();

    // 2. 从环境变量读取
    const envConfig = this.readEnvConfig();

    // 3. 合并配置（优先级：环境变量 > Claude settings > 默认值）
    const config = this.mergeConfig(DEFAULT_CONFIG, claudeSettings, envConfig);

    logger.debug('配置加载完成');
    return config;
  }

  /**
   * 读取 Claude settings 文件
   */
  private readClaudeSettings(): Partial<XiaozhiConfig> {
    try {
      const content = fs.readFileSync(this.claudeSettingsPath, 'utf-8');
      const settings = JSON.parse(content);

      const config: Partial<XiaozhiConfig> = {};

      // 解析模型配置
      if (settings.env) {
        const env = settings.env as Record<string, unknown>;
        if (env.ANTHROPIC_MODEL) {
          config.model = { defaultModel: String(env.ANTHROPIC_MODEL) };
        }
        if (env.API_TIMEOUT_MS) {
          config.timeout = {
            ...DEFAULT_CONFIG.timeout,
            apiTimeout: parseInt(String(env.API_TIMEOUT_MS), 10)
          };
        }
      }

      return config;
    } catch {
      return {};
    }
  }

  /**
   * 从环境变量读取配置
   */
  private readEnvConfig(): Partial<XiaozhiConfig> {
    const config: Partial<XiaozhiConfig> = {};

    // 模型配置
    if (process.env.XIAOZHI_MODEL) {
      config.model = { defaultModel: process.env.XIAOZHI_MODEL };
    }

    // 超时配置
    const timeout: Partial<TimeoutConfig> = {};
    if (process.env.XIAOZHI_API_TIMEOUT) {
      timeout.apiTimeout = parseInt(process.env.XIAOZHI_API_TIMEOUT, 10);
    }
    if (process.env.XIAOZHI_EXPERT_TIMEOUT) {
      timeout.expertTimeout = parseInt(process.env.XIAOZHI_EXPERT_TIMEOUT, 10);
    }
    if (Object.keys(timeout).length > 0) {
      config.timeout = { ...DEFAULT_CONFIG.timeout, ...timeout };
    }

    // 队列配置
    const queue: Partial<QueueConfig> = {};
    if (process.env.XIAOZHI_QUEUE_SIZE) {
      queue.maxSize = parseInt(process.env.XIAOZHI_QUEUE_SIZE, 10);
    }
    if (process.env.XIAOZHI_QUEUE_BEHAVIOR) {
      const behavior = process.env.XIAOZHI_QUEUE_BEHAVIOR;
      if (['reject', 'drop_oldest', 'drop_newest'].includes(behavior)) {
        queue.fullBehavior = behavior as QueueConfig['fullBehavior'];
      }
    }
    if (Object.keys(queue).length > 0) {
      config.queue = { ...DEFAULT_CONFIG.queue, ...queue };
    }

    // 安全配置
    if (process.env.XIAOZHI_API_TOKEN) {
      config.security = { ...DEFAULT_CONFIG.security, apiToken: process.env.XIAOZHI_API_TOKEN };
    }

    // 日志级别
    if (process.env.XIAOZHI_LOG_LEVEL) {
      const level = process.env.XIAOZHI_LOG_LEVEL;
      if (['debug', 'info', 'warn', 'error'].includes(level)) {
        config.log = { ...DEFAULT_CONFIG.log, level: level as LogConfig['level'] };
      }
    }

    return config;
  }

  /**
   * 合并配置
   */
  private mergeConfig(
    defaults: XiaozhiConfig,
    ...sources: Partial<XiaozhiConfig>[]
  ): XiaozhiConfig {
    const result = { ...defaults };

    for (const source of sources) {
      for (const key of Object.keys(source) as Array<keyof XiaozhiConfig>) {
        if (source[key] !== undefined) {
          result[key] = { ...result[key], ...source[key] } as any;
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
  getConfig(): XiaozhiConfig {
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
   * 重新加载配置
   */
  reload(): void {
    this.config = this.loadConfig();
    logger.info('配置已重新加载');
  }

  /**
   * 获取 Claude 环境配置（用于子进程）
   */
  getClaudeEnv(): Record<string, string> {
    try {
      const content = fs.readFileSync(this.claudeSettingsPath, 'utf-8');
      const settings = JSON.parse(content);
      const env: Record<string, string> = {};

      if (settings.env && typeof settings.env === 'object') {
        const settingsEnv = settings.env as Record<string, unknown>;
        for (const [key, value] of Object.entries(settingsEnv)) {
          if (typeof value === 'string' || typeof value === 'number') {
            env[key] = String(value);
          }
        }
      }

      return env;
    } catch {
      return {};
    }
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

/**
 * 获取所有 Claude 环境配置
 */
export function getClaudeEnv(): Record<string, string> {
  return configManager.getClaudeEnv();
}

// ==================== 路径配置 ====================

/**
 * 获取小智配置目录
 */
export function getXiaozhiHome(): string {
  return process.env.XIAOZHI_HOME || path.join(os.homedir(), '.xiaozhi');
}

/**
 * 获取小智工作目录
 */
export function getXiaozhiWorkspace(): string {
  return path.join(getXiaozhiHome(), 'workspace');
}

/**
 * 获取小智锁文件目录
 */
export function getXiaozhiLocksDir(): string {
  return path.join(getXiaozhiHome(), 'locks');
}

/**
 * 获取小智升级目录
 */
export function getXiaozhiUpgradesDir(): string {
  return path.join(getXiaozhiHome(), 'upgrades');
}

/**
 * 获取小智专家目录
 */
export function getXiaozhiExpertsDir(): string {
  return path.join(getXiaozhiHome(), 'experts');
}

/**
 * 获取小智 Workers 目录
 */
export function getXiaozhiWorkersDir(): string {
  return path.join(getXiaozhiHome(), 'workers');
}

/**
 * 获取小智数据库路径
 */
export function getXiaozhiDbPath(): string {
  return path.join(getXiaozhiHome(), 'xiaozhi.db');
}

/**
 * 获取小智系统提示词文件路径
 */
export function getSystemPromptPath(): string {
  return path.join(getXiaozhiHome(), 'system-prompt.md');
}

/**
 * 获取小智项目代码目录
 */
export function getXiaozhiProjectDir(): string {
  return process.env.XIAOZHI_DIR || path.join(os.homedir(), 'data', 'claudeClaw', 'xiaozhi');
}

/**
 * 统一路径配置对象
 */
export const PATHS = {
  get XIAOZHI_HOME() {
    return getXiaozhiHome();
  },
  get WORKSPACE() {
    return getXiaozhiWorkspace();
  },
  get LOCKS_DIR() {
    return getXiaozhiLocksDir();
  },
  get UPGRADES_DIR() {
    return getXiaozhiUpgradesDir();
  },
  get EXPERTS_DIR() {
    return getXiaozhiExpertsDir();
  },
  get WORKERS_DIR() {
    return getXiaozhiWorkersDir();
  },
  get DB_PATH() {
    return getXiaozhiDbPath();
  },
  get SYSTEM_PROMPT_FILE() {
    return getSystemPromptPath();
  },
  get XIAOZHI_DIR() {
    return getXiaozhiProjectDir();
  },
};
