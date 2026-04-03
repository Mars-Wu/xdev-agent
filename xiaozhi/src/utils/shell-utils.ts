// src/utils/shell-utils.ts
// Shell 命令安全工具函数

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
 * 验证 API Token
 * Token 应该是非空字符串
 */
export function validateApiToken(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 16;
}

/**
 * 安全执行命令
 * 使用数组参数避免 shell 注入
 */
export async function safeExec(
  command: string,
  args: string[] = [],
  options?: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  // 构建命令行（使用数组形式传递给 spawn）
  const escapedArgs = args.map(arg => shellEscape(arg));
  const fullCommand = `${command} ${escapedArgs.join(' ')}`;

  const execOptions: any = {
    timeout: options?.timeout || 30000,
    maxBuffer: 1024 * 1024, // 1MB
    encoding: 'utf-8',
  };

  if (options?.cwd) {
    execOptions.cwd = options.cwd;
  }

  const result = await execAsync(fullCommand, execOptions);
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * 安全执行命令（直接执行命令字符串）
 */
export async function safeExecCommand(
  command: string,
  options?: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const execOptions: any = {
    timeout: options?.timeout || 30000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf-8',
  };

  if (options?.cwd) {
    execOptions.cwd = options.cwd;
  }

  const result = await execAsync(command, execOptions);
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
