// src/upgrade/security-utils.ts
// 升级系统安全工具函数

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';

const logger = createLogger('upgrade-security');

/**
 * 验证 commit hash 格式
 * commit hash 必须是 40 位十六进制字符
 */
export function validateCommitHash(hash: string): boolean {
  return /^[a-f0-9]{40}$/i.test(hash);
}

/**
 * 验证 tmux 会话名
 * 只允许字母、数字、下划线和连字符
 */
export function validateTmuxSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 100;
}

/**
 * 验证 git commit 消息
 * 移除危险字符，限制长度
 */
export function sanitizeCommitMessage(message: string): string {
  // 移除可能导致命令注入的字符
  let sanitized = message
    .replace(/["`$\\]/g, '')  // 移除引号和特殊字符
    .replace(/\n/g, ' ')       // 将换行转为空格
    .trim();

  // 限制长度
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 200) + '...';
  }

  return sanitized;
}

/**
 * 验证升级 ID 格式
 * 格式: YYYY-MM-DD_HHMM
 */
export function validateUpgradeId(id: string): boolean {
  return /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(id);
}

/**
 * 验证路径在预期目录内（防止路径遍历）
 */
export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

/**
 * 验证文件路径安全性
 */
export function validateFilePath(filePath: string, allowedBaseDir: string): boolean {
  // 检查路径遍历攻击
  if (filePath.includes('..')) {
    return false;
  }

  // 检查是否在允许的目录内
  return isPathWithinDirectory(filePath, allowedBaseDir);
}

/**
 * 验证端口号
 */
export function validatePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/**
 * 验证 API Token
 * Token 应该是非空字符串
 */
export function validateApiToken(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 16;
}

/**
 * 文件锁 - 用于跨进程互斥
 */
export class FileLock {
  private lockPath: string;
  private locked: boolean = false;

  constructor(lockName: string, private baseDir: string) {
    this.lockPath = path.join(baseDir, `${lockName}.lock`);
  }

  /**
   * 尝试获取锁
   * @param timeout 超时时间（毫秒）
   * @returns 是否成功获取锁
   */
  async acquire(timeout: number = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // 尝试创建锁文件（独占模式）
        const handle = await fs.open(this.lockPath, 'wx');
        await handle.write(Buffer.from(JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        })));
        await handle.close();
        this.locked = true;
        logger.debug(`文件锁已获取: ${this.lockPath}`);
        return true;
      } catch (error: unknown) {
        const err = error as { code?: string };
        if (err.code === 'EEXIST') {
          // 锁文件已存在，检查是否过期
          try {
            const content = await fs.readFile(this.lockPath, 'utf-8');
            const lockInfo = JSON.parse(content);
            const lockAge = Date.now() - new Date(lockInfo.acquiredAt).getTime();

            // 如果锁超过 5 分钟，认为是过期锁，可以强制获取
            if (lockAge > 5 * 60 * 1000) {
              logger.warn(`发现过期锁，强制获取: ${this.lockPath}`);
              await fs.unlink(this.lockPath);
              continue;
            }
          } catch {
            // 无法读取锁文件，可能已损坏，尝试删除
            try {
              await fs.unlink(this.lockPath);
              continue;
            } catch {
              // 忽略删除失败
            }
          }

          // 等待一段时间后重试
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          logger.error(`获取文件锁失败: ${this.lockPath}`, error);
          return false;
        }
      }
    }

    logger.warn(`获取文件锁超时: ${this.lockPath}`);
    return false;
  }

  /**
   * 释放锁
   */
  async release(): Promise<void> {
    if (!this.locked) {
      return;
    }

    try {
      await fs.unlink(this.lockPath);
      this.locked = false;
      logger.debug(`文件锁已释放: ${this.lockPath}`);
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code !== 'ENOENT') {
        logger.error(`释放文件锁失败: ${this.lockPath}`, error);
      }
    }
  }

  /**
   * 检查锁是否被持有
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * 创建升级系统的文件锁
 */
export function createUpgradeLock(): FileLock {
  const lockDir = path.join(os.homedir(), '.xiaozhi', 'upgrades');
  return new FileLock('upgrade', lockDir);
}

/**
 * 安全地执行带参数的命令
 * 使用 spawn 数组参数避免 shell 注入
 */
export function buildSafeCommand(command: string, args: string[]): { command: string; args: string[] } {
  return { command, args };
}

/**
 * P1 安全修复：shell 转义函数
 * 对字符串进行 shell 转义，防止注入攻击
 */
export function shellEscape(str: string): string {
  if (!str) return "''";

  // 如果字符串只包含安全字符，直接返回
  if (/^[a-zA-Z0-9_\-./]+$/.test(str)) {
    return str;
  }

  // 使用单引号包裹，并转义内部的单引号
  // 单引号内的单引号需要用 '\'' 来转义
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * P1 安全修复：验证并转义路径用于 shell 命令
 * 结合路径验证和 shell 转义
 */
export function validateAndEscapePath(filePath: string, allowedBaseDir: string): string {
  // 先验证路径安全性
  if (!validateFilePath(filePath, allowedBaseDir)) {
    throw new Error(`路径不在允许的目录内: ${filePath}`);
  }

  // 再进行 shell 转义
  return shellEscape(filePath);
}
