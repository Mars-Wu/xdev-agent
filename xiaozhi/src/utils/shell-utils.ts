// src/utils/shell-utils.ts
// Shell 命令安全工具函数

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
