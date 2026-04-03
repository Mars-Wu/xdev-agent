// src/tools/worktree.ts
// Git Worktree 隔离工具

import { createLogger } from '../utils/logger'
import { safeExecCommand } from '../utils/shell-utils'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'

const logger = createLogger('worktree')

/**
 * Worktree 配置
 */
export interface WorktreeConfig {
  name: string
  baseBranch: string
  worktreePath?: string
}

/**
 * Worktree 会话
 */
export interface WorktreeSession {
  id: string
  name: string
  path: string
  branch: string
  originalPath: string
  createdAt: Date
}

/**
 * Worktree 管理器
 */
export class WorktreeManager {
  private worktreesDir: string
  private activeSessions: Map<string, WorktreeSession> = new Map()

  constructor(worktreesDir?: string) {
    this.worktreesDir = worktreesDir || path.join(os.homedir(), '.xiaozhi', 'worktrees')
  }

  /**
   * 确保 worktrees 目录存在
   */
  private async ensureWorktreesDir(): Promise<void> {
    await fs.mkdir(this.worktreesDir, { recursive: true })
  }

  /**
   * 创建 Worktree
   */
  async createWorktree(config: WorktreeConfig): Promise<WorktreeSession> {
    await this.ensureWorktreesDir()

    const id = `wt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const worktreePath = config.worktreePath || path.join(this.worktreesDir, config.name || id)
    const branchName = `worktree/${config.name || id}`

    // 获取当前目录（假设是 git 仓库）
    const originalPath = process.cwd()

    // 检查是否在 git 仓库中
    try {
      await safeExecCommand('git rev-parse --git-dir', { cwd: originalPath })
    } catch {
      throw new Error('当前目录不是 Git 仓库')
    }

    // 创建新分支
    try {
      await safeExecCommand(`git branch ${branchName} ${config.baseBranch}`, { cwd: originalPath })
    } catch (error) {
      // 分支可能已存在，尝试使用
      logger.warn(`分支 ${branchName} 可能已存在:`, error)
    }

    // 创建 worktree
    await safeExecCommand(`git worktree add -b ${branchName} "${worktreePath}" ${config.baseBranch}`, {
      cwd: originalPath,
    })

    const session: WorktreeSession = {
      id,
      name: config.name || id,
      path: worktreePath,
      branch: branchName,
      originalPath,
      createdAt: new Date(),
    }

    this.activeSessions.set(id, session)
    logger.info(`创建 Worktree: ${session.name} at ${session.path}`)

    return session
  }

  /**
   * 进入 Worktree
   */
  async enterWorktree(sessionId: string): Promise<WorktreeSession | null> {
    const session = this.activeSessions.get(sessionId)
    if (!session) {
      throw new Error(`Worktree 会话不存在: ${sessionId}`)
    }

    // 验证 worktree 存在
    try {
      await fs.access(session.path)
    } catch {
      throw new Error(`Worktree 路径不存在: ${session.path}`)
    }

    // 切换工作目录
    process.chdir(session.path)
    logger.info(`进入 Worktree: ${session.name}`)

    return session
  }

  /**
   * 退出 Worktree
   */
  async exitWorktree(
    sessionId: string,
    action: 'keep' | 'remove',
    discardChanges: boolean = false
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId)
    if (!session) {
      throw new Error(`Worktree 会话不存在: ${sessionId}`)
    }

    // 切换回原始目录
    process.chdir(session.originalPath)

    if (action === 'remove') {
      await this.removeWorktree(session, discardChanges)
    }

    this.activeSessions.delete(sessionId)
    logger.info(`退出 Worktree: ${session.name}, action: ${action}`)
  }

  /**
   * 移除 Worktree
   */
  private async removeWorktree(session: WorktreeSession, discardChanges: boolean): Promise<void> {
    // 检查是否有未提交的更改
    if (!discardChanges) {
      const { stdout } = await safeExecCommand('git status --porcelain', { cwd: session.path })
      if (stdout.trim()) {
        throw new Error(
          `Worktree 有未提交的更改。使用 discardChanges=true 强制删除。\n` +
          `更改文件:\n${stdout.slice(0, 500)}`
        )
      }
    }

    // 移除 worktree
    await safeExecCommand(`git worktree remove "${session.path}" --force`, {
      cwd: session.originalPath,
    })

    // 删除分支
    try {
      await safeExecCommand(`git branch -D ${session.branch}`, { cwd: session.originalPath })
    } catch (error) {
      logger.warn(`删除分支失败: ${session.branch}`, error)
    }

    logger.info(`已移除 Worktree: ${session.name}`)
  }

  /**
   * 获取活跃会话
   */
  getActiveSessions(): WorktreeSession[] {
    return Array.from(this.activeSessions.values())
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): WorktreeSession | undefined {
    return this.activeSessions.get(sessionId)
  }

  /**
   * 列出所有 Git Worktrees
   */
  async listWorktrees(): Promise<Array<{ path: string; branch: string; commit: string }>> {
    const { stdout } = await safeExecCommand('git worktree list --porcelain')
    const worktrees: Array<{ path: string; branch: string; commit: string }> = []

    const lines = stdout.split('\n')
    let current: any = {}

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          worktrees.push(current)
        }
        current = { path: line.slice(9) }
      } else if (line.startsWith('HEAD ')) {
        current.commit = line.slice(5)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7)
      }
    }

    if (current.path) {
      worktrees.push(current)
    }

    return worktrees
  }

  /**
   * 清理孤立 worktrees
   */
  async pruneWorktrees(): Promise<void> {
    await safeExecCommand('git worktree prune')
    logger.info('已清理孤立 worktrees')
  }
}

// 单例
let worktreeManagerInstance: WorktreeManager | null = null

export function getWorktreeManager(): WorktreeManager {
  if (!worktreeManagerInstance) {
    worktreeManagerInstance = new WorktreeManager()
  }
  return worktreeManagerInstance
}

export function resetWorktreeManager(): void {
  worktreeManagerInstance = null
}

/**
 * 工具定义：Enter Worktree
 */
export const enterWorktreeToolDefinition = {
  name: 'EnterWorktree',
  description: '在隔离的 Git Worktree 中执行任务',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'Worktree 名称',
      },
      baseBranch: {
        type: 'string',
        description: '基础分支（默认当前分支）',
      },
    },
    required: ['name'],
  },
}

/**
 * 工具定义：Exit Worktree
 */
export const exitWorktreeToolDefinition = {
  name: 'ExitWorktree',
  description: '退出当前 Worktree 会话',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: 'keep: 保留 worktree, remove: 删除 worktree',
      },
      discardChanges: {
        type: 'boolean',
        description: '是否丢弃未提交的更改（仅 remove 时有效）',
      },
    },
    required: ['action'],
  },
}

// === 工具创建函数 ===

import type { Tool, ToolResult } from './tool-interface'
import { successResult, errorResult } from './tool-interface'

/**
 * 创建 Worktree 管理工具
 */
export function createWorktreeTool(): Tool {
  const manager = getWorktreeManager()

  return {
    definition: {
      name: 'worktree',
      description:
        '管理 Git Worktree 隔离环境。创建、列表、删除 worktree。' +
        'Worktree 提供独立的 Git 工作目录，适合：' +
        '- 并行开发多个功能' +
        '- 隔离实验性修改' +
        '- 避免分支切换冲突',
      parameters: {
        action: {
          type: 'string',
          description: '操作类型: create(创建), list(列表), sessions(会话列表), get(详情)',
          enum: ['create', 'list', 'sessions', 'get'],
        },
        name: {
          type: 'string',
          description: 'Worktree 名称',
        },
        baseBranch: {
          type: 'string',
          description: '基础分支（create 时使用）',
        },
        id: {
          type: 'string',
          description: 'Worktree 会话 ID（get 时使用）',
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string

      try {
        switch (action) {
          case 'create': {
            const name = params.name as string
            if (!name) {
              return errorResult('创建 worktree 需要提供 name 参数')
            }

            const session = await manager.createWorktree({
              name,
              baseBranch: (params.baseBranch as string) || 'HEAD',
            })

            return successResult(
              `Worktree 已创建\nID: ${session.id}\n名称: ${session.name}\n路径: ${session.path}\n分支: ${session.branch}`
            )
          }

          case 'list': {
            const worktrees = await manager.listWorktrees()
            if (worktrees.length === 0) {
              return successResult('暂无 git worktree')
            }

            const lines = ['## Git Worktree 列表', '']
            for (const wt of worktrees) {
              lines.push(`- 路径: ${wt.path}`)
              lines.push(`  分支: ${wt.branch || 'DETACHED'}`)
              lines.push(`  提交: ${wt.commit.slice(0, 7)}`)
              lines.push('')
            }

            return successResult(lines.join('\n'))
          }

          case 'sessions': {
            const sessions = manager.getActiveSessions()
            if (sessions.length === 0) {
              return successResult('暂无活跃的 worktree 会话')
            }

            const lines = ['## Worktree 会话', '']
            for (const s of sessions) {
              lines.push(`- **${s.name}** (${s.id})`)
              lines.push(`  路径: ${s.path}`)
              lines.push(`  分支: ${s.branch}`)
              lines.push(`  创建: ${s.createdAt.toLocaleString()}`)
              lines.push('')
            }

            return successResult(lines.join('\n'))
          }

          case 'get': {
            const id = params.id as string
            if (!id) {
              return errorResult('获取 worktree 需要提供 id 参数')
            }

            const session = manager.getSession(id)
            if (!session) {
              return errorResult(`Worktree 会话不存在: ${id}`)
            }

            return successResult(
              `# Worktree: ${session.id}\n\n` +
              `- 名称: ${session.name}\n` +
              `- 路径: ${session.path}\n` +
              `- 分支: ${session.branch}\n` +
              `- 创建: ${session.createdAt.toLocaleString()}`
            )
          }

          default:
            return errorResult(`未知操作: ${action}`)
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`Worktree 操作失败: ${action}`, error)
        return errorResult(`操作失败: ${errorMsg}`)
      }
    },
  }
}

/**
 * 创建进入 Worktree 工具
 */
export function createEnterWorktreeTool(): Tool {
  return {
    definition: {
      name: 'enter_worktree',
      description: '进入隔离的 Git Worktree 执行任务',
      parameters: {
        name: {
          type: 'string',
          description: 'Worktree 名称',
        },
        baseBranch: {
          type: 'string',
          description: '基础分支（默认当前分支）',
        },
      },
      required: ['name'],
      dangerous: false,
      readOnly: false,
    },
    execute: async (params: Record<string, unknown>) => {
      // 这个工具主要是声明式的，实际逻辑由系统处理
      return successResult(`准备进入 worktree: ${params.name}`)
    },
  }
}

/**
 * 创建退出 Worktree 工具
 */
export function createExitWorktreeTool(): Tool {
  return {
    definition: {
      name: 'exit_worktree',
      description: '退出当前 Worktree 会话',
      parameters: {
        action: {
          type: 'string',
          description: 'keep: 保留 worktree, remove: 删除 worktree',
          enum: ['keep', 'remove'],
        },
        discardChanges: {
          type: 'boolean',
          description: '是否丢弃未提交的更改（仅 remove 时有效）',
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: false,
    },
    execute: async (params: Record<string, unknown>) => {
      // 这个工具主要是声明式的，实际逻辑由系统处理
      return successResult(`准备退出 worktree，操作: ${params.action}`)
    },
  }
}
