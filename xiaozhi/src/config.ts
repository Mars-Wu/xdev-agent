// src/config.ts
// 统一配置管理 - 所有配置优先从 ~/.claude/settings.json 读取

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Claude 配置文件路径
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// 默认值（当配置文件不存在时使用）
const DEFAULTS = {
  MODEL: 'glm-5',
  TIMEOUT_MS: 3000000,
};

/**
 * 读取 ~/.claude/settings.json
 */
function readClaudeSettings(): Record<string, unknown> {
  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * 获取默认模型
 * 优先级: settings.json > 环境变量 > 默认值
 */
export function getDefaultModel(): string {
  // 1. 从 ~/.claude/settings.json 读取
  const settings = readClaudeSettings();
  if (settings.env && typeof settings.env === 'object') {
    const env = settings.env as Record<string, unknown>;
    if (env.ANTHROPIC_MODEL && typeof env.ANTHROPIC_MODEL === 'string') {
      return env.ANTHROPIC_MODEL;
    }
  }

  // 2. 从环境变量读取
  if (process.env.XIAOZHI_MODEL) {
    return process.env.XIAOZHI_MODEL;
  }

  // 3. 返回默认值
  return DEFAULTS.MODEL;
}

/**
 * 获取 API 超时时间（毫秒）
 */
export function getApiTimeout(): number {
  const settings = readClaudeSettings();
  if (settings.env && typeof settings.env === 'object') {
    const env = settings.env as Record<string, unknown>;
    if (env.API_TIMEOUT_MS) {
      return parseInt(String(env.API_TIMEOUT_MS), 10);
    }
  }
  return DEFAULTS.TIMEOUT_MS;
}

/**
 * 获取所有 Claude 环境配置
 * 用于传递给子进程（如 Worker）
 */
export function getClaudeEnv(): Record<string, string> {
  const settings = readClaudeSettings();
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
}

// 导出常量供其他模块使用
export const CONFIG = {
  get MODEL() {
    return getDefaultModel();
  },
  get API_TIMEOUT() {
    return getApiTimeout();
  },
};

// ==================== P1 统一路径配置管理 ====================

/**
 * 获取小智配置目录
 * 优先级: 环境变量 XIAOZHI_HOME > 默认值 ~/.xiaozhi
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
 * 优先级: 环境变量 XIAOZHI_DIR > 默认值 ~/data/claudeClaw/xiaozhi
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
