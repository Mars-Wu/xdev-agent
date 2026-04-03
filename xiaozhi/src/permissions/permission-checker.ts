// src/permissions/permission-checker.ts
// 多层权限检查系统

import { createLogger } from '../utils/logger'

const logger = createLogger('permissions')

/**
 * 权限级别
 */
export enum PermissionLevel {
  /** 只读操作 */
  READ_ONLY = 'read_only',
  /** 标准操作 */
  STANDARD = 'standard',
  /** 危险操作（需要确认） */
  DANGEROUS = 'dangerous',
  /** 管理员操作 */
  ADMIN = 'admin',
}

/**
 * 权限模式
 */
export enum PermissionMode {
  /** 默认模式 - 危险操作需要确认 */
  DEFAULT = 'default',
  /** 自动接受编辑 - 编辑操作自动执行 */
  ACCEPT_EDITS = 'acceptEdits',
  /** 绕过权限 - 所有操作自动执行 */
  BYPASS = 'bypassPermissions',
  /** 计划模式 - 只生成计划，不执行 */
  PLAN = 'plan',
}

/**
 * 工具分类
 */
export enum ToolCategory {
  /** 文件读取 */
  FILE_READ = 'file_read',
  /** 文件写入 */
  FILE_WRITE = 'file_write',
  /** 文件编辑 */
  FILE_EDIT = 'file_edit',
  /** Shell 命令 */
  SHELL = 'shell',
  /** 网络请求 */
  NETWORK = 'network',
  /** 进程管理 */
  PROCESS = 'process',
  /** 系统配置 */
  SYSTEM = 'system',
  /** 代码执行 */
  CODE_EXEC = 'code_exec',
  /** Git 操作 */
  GIT = 'git',
}

/**
 * 权限检查结果
 */
export interface PermissionResult {
  allowed: boolean
  level: PermissionLevel
  reason?: string
  requiresConfirmation: boolean
  autoApprove: boolean
  riskScore: number // 0-100
}

/**
 * 权限规则
 */
export interface PermissionRule {
  pattern: string | RegExp
  category: ToolCategory
  level: PermissionLevel
  autoApprove?: boolean
  reason?: string
}

/**
 * 危险命令模式
 */
const DANGEROUS_PATTERNS = [
  // 文件系统
  /\brm\s+-rf\b/,
  /\brm\s+.*\*/,  // rm with wildcard
  /\brmdir\s+/,
  /\bmv\s+.*\/dev\/null\b/,
  /\bchmod\s+000\b/,
  /\bchown\s+.*:.*\s+\//,

  // 网络
  /\bcurl\s+.*\|\s*bash\b/,
  /\bwget\s+.*\|\s*bash\b/,
  /\bnc\s+-l\b/,  // netcat listen
  /\bncat\s+-l\b/,

  // 进程
  /\bkill\s+-9\b/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bsystemctl\s+(stop|disable|restart)\b/,
  /\bservice\s+.*\s+stop\b/,

  // 用户管理
  /\buseradd\b/,
  /\buserdel\b/,
  /\bpasswd\b/,
  /\busermod\b/,

  // 系统配置
  /\biptables\b/,
  /\bfirewall-cmd\b/,
  /\bsysctl\b/,
  /\bgrub\b/,

  // 包管理器卸载
  /\bapt(-get)?\s+(remove|purge)\b/,
  /\byum\s+remove\b/,
  /\bdnf\s+remove\b/,
  /\bpacman\s+-R\b/,
  /\bnpm\s+(uninstall|rm)\s+-g\b/,

  // Git 危险操作
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-fdx\b/,
  /\bgit\s+checkout\s+--\s*\.\b/,
]

/**
 * 只读命令模式
 */
const READ_ONLY_PATTERNS = [
  /\bcat\b/,
  /\bhead\b/,
  /\btail\b/,
  /\bls\b/,
  /\bfind\b/,
  /\bgrep\b/,
  /\bwc\b/,
  /\bstat\b/,
  /\bfile\b/,
  /\bdu\b/,
  /\bdf\b/,
  /\bps\b/,
  /\btop\b/,
  /\bhtop\b/,
  /\bgit\s+(status|log|diff|show|branch|tag)\b/,
  /\bsystemctl\s+status\b/,
  /\bjournalctl\b/,
]

/**
 * 默认权限规则
 */
const DEFAULT_RULES: PermissionRule[] = [
  // 只读操作
  { pattern: 'Read', category: ToolCategory.FILE_READ, level: PermissionLevel.READ_ONLY, autoApprove: true },
  { pattern: 'Glob', category: ToolCategory.FILE_READ, level: PermissionLevel.READ_ONLY, autoApprove: true },
  { pattern: 'Grep', category: ToolCategory.FILE_READ, level: PermissionLevel.READ_ONLY, autoApprove: true },

  // 文件写入
  { pattern: 'Write', category: ToolCategory.FILE_WRITE, level: PermissionLevel.STANDARD },
  { pattern: 'Edit', category: ToolCategory.FILE_EDIT, level: PermissionLevel.STANDARD },

  // Shell 命令
  { pattern: 'Bash', category: ToolCategory.SHELL, level: PermissionLevel.STANDARD },

  // 网络请求
  { pattern: 'WebFetch', category: ToolCategory.NETWORK, level: PermissionLevel.READ_ONLY, autoApprove: true },
  { pattern: 'WebSearch', category: ToolCategory.NETWORK, level: PermissionLevel.READ_ONLY, autoApprove: true },

  // Git 操作
  { pattern: /^git\s+(status|log|diff|show|branch)/, category: ToolCategory.GIT, level: PermissionLevel.READ_ONLY, autoApprove: true },
  { pattern: /^git\s+(add|commit|push|pull|merge)/, category: ToolCategory.GIT, level: PermissionLevel.STANDARD },
  { pattern: /^git\s+(reset|rebase|cherry-pick)/, category: ToolCategory.GIT, level: PermissionLevel.DANGEROUS },

  // 进程管理
  { pattern: /^ps\b/, category: ToolCategory.PROCESS, level: PermissionLevel.READ_ONLY, autoApprove: true },
  { pattern: /^kill\b/, category: ToolCategory.PROCESS, level: PermissionLevel.DANGEROUS },
]

/**
 * 权限检查器配置
 */
export interface PermissionCheckerConfig {
  mode: PermissionMode
  autoApproveReads: boolean
  autoApproveNetwork: boolean
  requireConfirmationFor: ToolCategory[]
  blockedCommands: string[]
  allowedPaths?: string[]
  blockedPaths?: string[]
}

const DEFAULT_CONFIG: PermissionCheckerConfig = {
  mode: PermissionMode.DEFAULT,
  autoApproveReads: true,
  autoApproveNetwork: true,
  requireConfirmationFor: [
    ToolCategory.SHELL,
    ToolCategory.PROCESS,
    ToolCategory.SYSTEM,
  ],
  blockedCommands: [],
}

/**
 * 权限检查器
 */
export class PermissionChecker {
  private config: PermissionCheckerConfig
  private rules: PermissionRule[] = [...DEFAULT_RULES]

  constructor(config: Partial<PermissionCheckerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 检查工具权限
   */
  checkToolPermission(
    toolName: string,
    input: Record<string, unknown>
  ): PermissionResult {
    // 绕过模式
    if (this.config.mode === PermissionMode.BYPASS) {
      return {
        allowed: true,
        level: PermissionLevel.ADMIN,
        requiresConfirmation: false,
        autoApprove: true,
        riskScore: 0,
      }
    }

    // 计划模式 - 不执行
    if (this.config.mode === PermissionMode.PLAN) {
      return {
        allowed: false,
        level: PermissionLevel.READ_ONLY,
        reason: '计划模式下不执行操作',
        requiresConfirmation: false,
        autoApprove: false,
        riskScore: 0,
      }
    }

    // 查找匹配规则
    const rule = this.findMatchingRule(toolName)
    const level = rule?.level || PermissionLevel.STANDARD
    const riskScore = this.calculateRiskScore(toolName, input, level)

    // 检查是否在阻止列表
    if (this.isBlocked(toolName, input)) {
      return {
        allowed: false,
        level,
        reason: '操作在阻止列表中',
        requiresConfirmation: false,
        autoApprove: false,
        riskScore: 100,
      }
    }

    // 判断是否需要确认
    const requiresConfirmation = this.requiresConfirmation(toolName, level, riskScore)

    // 判断是否自动批准
    const autoApprove = this.canAutoApprove(toolName, level, rule)

    return {
      allowed: true,
      level,
      requiresConfirmation,
      autoApprove,
      riskScore,
    }
  }

  /**
   * 检查命令权限
   */
  checkCommandPermission(command: string): PermissionResult {
    // 绕过模式
    if (this.config.mode === PermissionMode.BYPASS) {
      return {
        allowed: true,
        level: PermissionLevel.ADMIN,
        requiresConfirmation: false,
        autoApprove: true,
        riskScore: 0,
      }
    }

    // 检查危险命令
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return {
          allowed: true,
          level: PermissionLevel.DANGEROUS,
          reason: '危险命令需要确认',
          requiresConfirmation: true,
          autoApprove: false,
          riskScore: 80,
        }
      }
    }

    // 检查只读命令
    for (const pattern of READ_ONLY_PATTERNS) {
      if (pattern.test(command)) {
        return {
          allowed: true,
          level: PermissionLevel.READ_ONLY,
          requiresConfirmation: false,
          autoApprove: this.config.autoApproveReads,
          riskScore: 10,
        }
      }
    }

    // 检查阻止列表
    for (const blocked of this.config.blockedCommands) {
      if (command.includes(blocked)) {
        return {
          allowed: false,
          level: PermissionLevel.DANGEROUS,
          reason: `命令包含阻止项: ${blocked}`,
          requiresConfirmation: false,
          autoApprove: false,
          riskScore: 100,
        }
      }
    }

    // 默认标准权限
    return {
      allowed: true,
      level: PermissionLevel.STANDARD,
      requiresConfirmation: this.config.requireConfirmationFor.includes(ToolCategory.SHELL),
      autoApprove: false,
      riskScore: 40,
    }
  }

  /**
   * 检查路径权限
   */
  checkPathPermission(path: string, operation: 'read' | 'write'): PermissionResult {
    // 检查阻止路径
    if (this.config.blockedPaths) {
      for (const blocked of this.config.blockedPaths) {
        if (path.startsWith(blocked)) {
          return {
            allowed: false,
            level: PermissionLevel.DANGEROUS,
            reason: `路径在阻止列表中: ${blocked}`,
            requiresConfirmation: false,
            autoApprove: false,
            riskScore: 100,
          }
        }
      }
    }

    // 检查允许路径（如果配置了）
    if (this.config.allowedPaths && this.config.allowedPaths.length > 0) {
      const isAllowed = this.config.allowedPaths.some(allowed => path.startsWith(allowed))
      if (!isAllowed) {
        return {
          allowed: false,
          level: PermissionLevel.STANDARD,
          reason: '路径不在允许列表中',
          requiresConfirmation: false,
          autoApprove: false,
          riskScore: 60,
        }
      }
    }

    const level = operation === 'read' ? PermissionLevel.READ_ONLY : PermissionLevel.STANDARD
    return {
      allowed: true,
      level,
      requiresConfirmation: operation === 'write',
      autoApprove: operation === 'read' && this.config.autoApproveReads,
      riskScore: operation === 'read' ? 10 : 30,
    }
  }

  /**
   * 查找匹配规则
   */
  private findMatchingRule(toolName: string): PermissionRule | undefined {
    for (const rule of this.rules) {
      if (typeof rule.pattern === 'string') {
        if (toolName === rule.pattern) return rule
      } else {
        if (rule.pattern.test(toolName)) return rule
      }
    }
    return undefined
  }

  /**
   * 计算风险分数
   */
  private calculateRiskScore(
    toolName: string,
    input: Record<string, unknown>,
    level: PermissionLevel
  ): number {
    let score = 0

    // 基础分数
    switch (level) {
      case PermissionLevel.READ_ONLY:
        score = 10
        break
      case PermissionLevel.STANDARD:
        score = 30
        break
      case PermissionLevel.DANGEROUS:
        score = 70
        break
      case PermissionLevel.ADMIN:
        score = 90
        break
    }

    // 工具特定风险
    if (toolName === 'Bash') {
      const command = String(input.command || '')
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          score += 20
          break
        }
      }
    }

    // 路径风险
    if (input.file_path || input.path) {
      const filePath = String(input.file_path || input.path)
      // 敏感路径
      if (filePath.includes('/etc/') || filePath.includes('/root/')) {
        score += 20
      }
      // 系统文件
      if (filePath.includes('.ssh/') || filePath.includes('.gnupg/')) {
        score += 30
      }
    }

    return Math.min(100, score)
  }

  /**
   * 是否需要确认
   */
  private requiresConfirmation(
    toolName: string,
    level: PermissionLevel,
    riskScore: number
  ): boolean {
    // 接受编辑模式
    if (this.config.mode === PermissionMode.ACCEPT_EDITS) {
      // 编辑类操作自动执行
      if (level === PermissionLevel.STANDARD && riskScore < 50) {
        return false
      }
    }

    // 危险操作总是需要确认
    if (level === PermissionLevel.DANGEROUS) {
      return true
    }

    // 高风险需要确认
    if (riskScore >= 70) {
      return true
    }

    return false
  }

  /**
   * 是否可以自动批准
   */
  private canAutoApprove(
    toolName: string,
    level: PermissionLevel,
    rule?: PermissionRule
  ): boolean {
    // 规则明确指定
    if (rule?.autoApprove !== undefined) {
      return rule.autoApprove
    }

    // 只读操作
    if (level === PermissionLevel.READ_ONLY && this.config.autoApproveReads) {
      return true
    }

    return false
  }

  /**
   * 检查是否被阻止
   */
  private isBlocked(toolName: string, input: Record<string, unknown>): boolean {
    for (const blocked of this.config.blockedCommands) {
      if (toolName.includes(blocked)) return true
      if (input.command && String(input.command).includes(blocked)) return true
    }
    return false
  }

  /**
   * 添加规则
   */
  addRule(rule: PermissionRule): void {
    this.rules.unshift(rule)
  }

  /**
   * 移除规则
   */
  removeRule(pattern: string | RegExp): void {
    const patternStr = pattern.toString()
    this.rules = this.rules.filter(r => r.pattern.toString() !== patternStr)
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PermissionCheckerConfig>): void {
    this.config = { ...this.config, ...config }
    logger.info(`权限模式更新: ${this.config.mode}`)
  }

  /**
   * 获取配置
   */
  getConfig(): PermissionCheckerConfig {
    return { ...this.config }
  }
}

// 单例
let permissionCheckerInstance: PermissionChecker | null = null

export function getPermissionChecker(
  config?: Partial<PermissionCheckerConfig>
): PermissionChecker {
  if (!permissionCheckerInstance) {
    permissionCheckerInstance = new PermissionChecker(config)
  }
  return permissionCheckerInstance
}

export function resetPermissionChecker(): void {
  permissionCheckerInstance = null
}
