// src/tools/command-safety.ts
// 危险命令检测 — 参考 Hermes agent/approval.py DANGEROUS_PATTERNS
// 分为硬阻断（直接拒绝）和警告（记录日志后允许执行）两级

export type SafetyLevel = 'safe' | 'warn' | 'block'

export interface SafetyCheckResult {
  level: SafetyLevel
  reason?: string
}

/**
 * 硬阻断模式：命中则直接拒绝执行
 */
const HARD_BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[^\s]*\s+)*\/(?:\s|$)/, '根路径删除'],
  [/\brm\s+--recursive\s+\/(?:\s|$)/, '根路径递归删除（--recursive）'],
  [/\bmkfs\b/, '格式化文件系统'],
  [/\bdd\s+.*\bif=/, '磁盘复制（dd）'],
  [/>\s*\/dev\/sd/, '写入块设备'],
  [/:\(\)\s*\{[^}]*:\s*\|[^}]*:\s*&/, 'Fork Bomb'],
  [/\/dev\/tcp\//, '网络反弹（/dev/tcp）'],
  [/\/dev\/udp\//, '网络反弹（/dev/udp）'],
  [/\bDROP\s+DATABASE\b/i, 'SQL DROP DATABASE'],
  [/\bDROP\s+TABLE\b/i, 'SQL DROP TABLE'],
  // 变量参数转换注入（已有，保留）
  [/\$\{[^}]*@[PQEAa]\}/, 'Shell 参数转换注入'],
  // 写入关键系统文件
  [/>\s*\/etc\/(?:passwd|shadow|sudoers)/, '写入关键系统配置文件'],
]

/**
 * 警告模式：记录日志，允许执行
 */
const WARN_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[^\s]*r[^\s]*|-[^\s]*-recursive)/, '递归删除'],
  [/\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/, '全局可写权限'],
  [/\bchown\s+(-[^\s]*)?[Rr]\s+root/, '递归改所有者为 root'],
  [/>\s*~\/\.ssh\//, '写入 SSH 配置目录'],
  [/>\s*~\/\.env\b/, '写入 .env 文件'],
  [/>\s*\/etc\//, '写入 /etc 目录'],
  [/\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i, 'SQL DELETE 无 WHERE 子句'],
  [/\bTRUNCATE\s+TABLE\b/i, 'SQL TRUNCATE TABLE'],
  [/\bexport\s+\w*(?:API_KEY|TOKEN|SECRET|PASSWORD)\w*\s*=/, '导出敏感环境变量'],
]

/**
 * 检查命令安全性
 * 同时对 Unicode 规范化后的字符串检查（防止全角字符绕过）
 */
export function checkCommandSafety(command: string): SafetyCheckResult {
  const normalized = command.normalize('NFKD')

  for (const [pattern, reason] of HARD_BLOCK_PATTERNS) {
    if (pattern.test(command) || pattern.test(normalized)) {
      return { level: 'block', reason }
    }
  }

  for (const [pattern, reason] of WARN_PATTERNS) {
    if (pattern.test(command) || pattern.test(normalized)) {
      return { level: 'warn', reason }
    }
  }

  return { level: 'safe' }
}
