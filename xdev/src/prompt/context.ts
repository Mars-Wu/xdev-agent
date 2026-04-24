// src/prompt/context.ts
// 动态上下文注入 - Git、环境信息

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { safeExecCommand } from '../utils/shell-utils';

const logger = createLogger('context');

/**
 * 上下文信息
 */
export interface ContextInfo {
  /** 当前日期 */
  currentDate: string;
  /** 工作目录 */
  cwd: string;
  /** Git 信息 */
  git: GitInfo | null;
  /** 环境变量（敏感信息已过滤） */
  env: Record<string, string>;
  /** 系统信息 */
  system: SystemInfo;
}

/**
 * Git 信息
 */
export interface GitInfo {
  /** 是否在 Git 仓库中 */
  isRepo: boolean;
  /** 当前分支 */
  branch: string;
  /** 远程仓库 */
  remote: string | null;
  /** 是否有未提交的更改 */
  hasChanges: boolean;
  /** 最后提交 */
  lastCommit: string | null;
  /** 当前标签 */
  tag: string | null;
}

/**
 * 系统信息
 */
export interface SystemInfo {
  /** 操作系统 */
  platform: string;
  /** 主机名 */
  hostname: string;
  /** 用户名 */
  username: string;
  /** Node.js 版本 */
  nodeVersion: string;
  /** 艾克斯版本 */
  xdevVersion: string;
}

/**
 * 获取动态上下文
 */
export async function getContextInfo(cwd?: string): Promise<ContextInfo> {
  const workDir = cwd || process.cwd();

  const [git, system] = await Promise.all([
    getGitInfo(workDir),
    getSystemInfo(),
  ]);

  return {
    currentDate: getFormattedDate(),
    cwd: workDir,
    git,
    env: getFilteredEnv(),
    system,
  };
}

/**
 * 获取格式化的日期
 */
function getFormattedDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 获取 Git 信息
 */
async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    // 检查是否在 Git 仓库中
    const { stdout: gitDir } = await safeExecCommand('git rev-parse --git-dir', { cwd });
    if (!gitDir) {
      return null;
    }

    // 并行获取所有 Git 信息
    const [
      branchResult,
      remoteResult,
      statusResult,
      lastCommitResult,
      tagResult,
    ] = await Promise.allSettled([
      safeExecCommand('git rev-parse --abbrev-ref HEAD', { cwd }),
      safeExecCommand('git remote get-url origin', { cwd }),
      safeExecCommand('git status --porcelain', { cwd }),
      safeExecCommand('git log -1 --format=%h %s', { cwd }),
      safeExecCommand('git describe --tags --exact-match 2>/dev/null || echo ""', { cwd }),
    ]);

    const branch = branchResult.status === 'fulfilled'
      ? branchResult.value.stdout.trim()
      : 'unknown';

    const remote = remoteResult.status === 'fulfilled'
      ? remoteResult.value.stdout.trim()
      : null;

    const hasChanges = statusResult.status === 'fulfilled'
      ? statusResult.value.stdout.trim().length > 0
      : false;

    const lastCommit = lastCommitResult.status === 'fulfilled'
      ? lastCommitResult.value.stdout.trim()
      : null;

    const tag = tagResult.status === 'fulfilled'
      ? tagResult.value.stdout.trim()
      : null;

    return {
      isRepo: true,
      branch,
      remote,
      hasChanges,
      lastCommit,
      tag,
    };
  } catch (error) {
    logger.debug('获取 Git 信息失败:', error);
    return null;
  }
}

/**
 * 获取过滤后的环境变量
 */
function getFilteredEnv(): Record<string, string> {
  // 敏感变量前缀
  const sensitivePrefixes = [
    'API_KEY',
    'SECRET',
    'PASSWORD',
    'TOKEN',
    'AUTH',
    'CREDENTIAL',
    'PRIVATE',
  ];

  // 允许的变量
  const allowedVars = [
    'NODE_ENV',
    'XDEV_MODEL',
    'XDEV_HOME',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
  ];

  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    // 检查是否为敏感变量
    const isSensitive = sensitivePrefixes.some(prefix =>
      key.toUpperCase().includes(prefix)
    );

    if (isSensitive) {
      continue;
    }

    // 检查是否在允许列表中
    if (allowedVars.includes(key)) {
      filtered[key] = value || '';
    }
  }

  return filtered;
}

/**
 * 获取系统信息
 */
async function getSystemInfo(): Promise<SystemInfo> {
  let xdevVersion = 'unknown';

  try {
    const packageJsonPath = path.join(__dirname, '../../package.json');
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content);
    xdevVersion = pkg.version || 'unknown';
  } catch {
    // 忽略
  }

  return {
    platform: process.platform,
    hostname: os.hostname(),
    username: os.userInfo().username,
    nodeVersion: process.version,
    xdevVersion,
  };
}

/**
 * 构建上下文注入 Prompt
 */
export function buildContextPrompt(context: ContextInfo): string {
  const lines: string[] = [
    `# currentDate`,
    `Today's date is ${context.currentDate}.`,
    '',
  ];

  // Git 信息
  if (context.git?.isRepo) {
    lines.push('# gitStatus');
    lines.push(`Current branch: ${context.git.branch}`);

    if (context.git.remote) {
      // 隐藏敏感的 Git URL
      const safeRemote = context.git.remote.replace(
        /(https?:\/\/[^:]*:)[^@]*@/,
        '$1****@'
      );
      lines.push(`Remote: ${safeRemote}`);
    }

    if (context.git.hasChanges) {
      lines.push('Working tree has uncommitted changes.');
    }

    if (context.git.lastCommit) {
      lines.push(`Last commit: ${context.git.lastCommit}`);
    }

    lines.push('');
  }

  // 工作目录
  lines.push('# Working Directory');
  lines.push(context.cwd);
  lines.push('');

  // 系统信息
  lines.push('# System');
  lines.push(`Platform: ${context.system.platform}`);
  lines.push(`User: ${context.system.username}`);
  lines.push(`Node.js: ${context.system.nodeVersion}`);
  lines.push(`Xdev: ${context.system.xdevVersion}`);

  return lines.join('\n');
}

/**
 * 获取简短的上下文摘要（用于 CLI 显示）
 */
export function getContextSummary(context: ContextInfo): string {
  const parts: string[] = [];

  if (context.git?.isRepo) {
    parts.push(`git:${context.git.branch}`);
    if (context.git.hasChanges) {
      parts.push('*');
    }
  }

  parts.push(context.cwd);

  return parts.join(' ');
}
