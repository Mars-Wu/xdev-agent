// src/tools/task-system.ts
// s07 Task System - 持久化任务图（DAG）与依赖管理

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { PATHS } from '../config'

const logger = createLogger('task-system')

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/**
 * 任务优先级
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'

/**
 * 任务定义
 */
export interface Task {
  /** 任务 ID */
  id: string
  /** 任务标题 */
  title: string
  /** 任务描述 */
  description: string
  /** 任务状态 */
  status: TaskStatus
  /** 优先级 */
  priority: TaskPriority
  /** 依赖的任务 ID 列表 */
  dependencies: string[]
  /** 阻塞的任务 ID 列表（被此任务阻塞） */
  blockedBy: string[]
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 开始时间 */
  startedAt?: number
  /** 完成时间 */
  completedAt?: number
  /** 执行者（Agent ID） */
  assignee?: string
  /** 标签 */
  tags: string[]
  /** 元数据 */
  metadata?: Record<string, unknown>
  /** 结果 */
  result?: string
  /** 错误信息 */
  error?: string
}

/**
 * 任务图
 */
export interface TaskGraph {
  /** 任务映射 */
  tasks: Map<string, Task>
  /** 文件路径 */
  filePath: string
  /** 最后保存时间 */
  lastSaved: number
}

/**
 * TaskSystem 配置
 */
export interface TaskSystemConfig {
  /** 任务图文件路径 */
  graphPath: string
  /** 自动保存间隔（毫秒） */
  autoSaveInterval: number
  /** 最大任务数 */
  maxTasks: number
}

const DEFAULT_CONFIG: TaskSystemConfig = {
  graphPath: path.join(PATHS.XIAOZHI_HOME, 'tasks', 'task-graph.json'),
  autoSaveInterval: 10000, // 10秒
  maxTasks: 100,
}

/**
 * TaskSystem - 持久化任务系统
 *
 * 特点：
 * - 任务依赖图（DAG）管理
 * - 自动检测循环依赖
 * - 任务状态转换
 * - 持久化存储
 */
export class TaskSystem {
  private config: TaskSystemConfig
  private tasks: Map<string, Task> = new Map()
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(config: Partial<TaskSystemConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 初始化任务系统
   */
  async initialize(): Promise<void> {
    // 确保目录存在
    const dir = path.dirname(this.config.graphPath)
    await fs.mkdir(dir, { recursive: true })

    // 加载现有任务
    await this.load()

    // 启动自动保存
    this.startAutoSave()

    logger.info(`任务系统已初始化，当前 ${this.tasks.size} 个任务`)
  }

  /**
   * 创建任务
   */
  createTask(
    title: string,
    description: string,
    options: {
      priority?: TaskPriority
      dependencies?: string[]
      tags?: string[]
      assignee?: string
      metadata?: Record<string, unknown>
    } = {}
  ): Task {
    const id = this.generateId()

    // 检查最大任务数
    if (this.tasks.size >= this.config.maxTasks) {
      throw new Error(`任务数量已达上限 (${this.config.maxTasks})`)
    }

    // 验证依赖
    const dependencies = options.dependencies || []
    for (const depId of dependencies) {
      if (!this.tasks.has(depId)) {
        throw new Error(`依赖的任务不存在: ${depId}`)
      }
    }

    // 检测循环依赖
    if (this.wouldCreateCycle(id, dependencies)) {
      throw new Error('检测到循环依赖')
    }

    const now = Date.now()
    const task: Task = {
      id,
      title,
      description,
      status: dependencies.length > 0 ? 'blocked' : 'pending',
      priority: options.priority || 'normal',
      dependencies,
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
      assignee: options.assignee,
      tags: options.tags || [],
      metadata: options.metadata,
    }

    // 更新被阻塞的任务列表
    for (const depId of dependencies) {
      const depTask = this.tasks.get(depId)!
      depTask.blockedBy.push(id)
    }

    this.tasks.set(id, task)
    this.markDirty()

    logger.info(`创建任务: ${id} - ${title}`)
    return task
  }

  /**
   * 更新任务状态
   */
  updateTaskStatus(id: string, status: TaskStatus, result?: string, error?: string): Task | null {
    const task = this.tasks.get(id)
    if (!task) {
      logger.warn(`任务不存在: ${id}`)
      return null
    }

    // 状态转换验证
    if (!this.isValidTransition(task.status, status)) {
      throw new Error(`无效的状态转换: ${task.status} -> ${status}`)
    }

    const now = Date.now()
    task.status = status
    task.updatedAt = now

    if (status === 'in_progress' && !task.startedAt) {
      task.startedAt = now
    }

    if (status === 'completed' || status === 'failed') {
      task.completedAt = now
      if (result) task.result = result
      if (error) task.error = error

      // 解锁被阻塞的任务
      this.unblockDependentTasks(id)
    }

    this.markDirty()
    logger.info(`更新任务状态: ${id} -> ${status}`)
    return task
  }

  /**
   * 开始任务
   */
  startTask(id: string, assignee?: string): Task | null {
    const task = this.tasks.get(id)
    if (!task) return null

    if (task.status === 'blocked') {
      throw new Error('任务被阻塞，无法开始')
    }

    if (assignee) {
      task.assignee = assignee
    }

    return this.updateTaskStatus(id, 'in_progress')
  }

  /**
   * 完成任务
   */
  completeTask(id: string, result?: string): Task | null {
    return this.updateTaskStatus(id, 'completed', result)
  }

  /**
   * 失败任务
   */
  failTask(id: string, error: string): Task | null {
    return this.updateTaskStatus(id, 'failed', undefined, error)
  }

  /**
   * 取消任务
   */
  cancelTask(id: string): Task | null {
    return this.updateTaskStatus(id, 'cancelled')
  }

  /**
   * 获取任务
   */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => {
        // 按优先级排序
        const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 }
        const pa = priorityOrder[a.priority]
        const pb = priorityOrder[b.priority]
        if (pa !== pb) return pa - pb
        // 再按创建时间排序
        return a.createdAt - b.createdAt
      })
  }

  /**
   * 获取可执行的任务（pending 且无阻塞）
   */
  getExecutableTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'pending')
  }

  /**
   * 获取被阻塞的任务
   */
  getBlockedTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'blocked')
  }

  /**
   * 获取进行中的任务
   */
  getInProgressTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'in_progress')
  }

  /**
   * 获取已完成的任务
   */
  getCompletedTasks(): Task[] {
    return this.getAllTasks().filter(t => t.status === 'completed')
  }

  /**
   * 获取任务依赖链
   */
  getDependencyChain(id: string): Task[] {
    const chain: Task[] = []
    const visited = new Set<string>()
    const task = this.tasks.get(id)

    if (!task) return chain

    const visit = (t: Task) => {
      if (visited.has(t.id)) return
      visited.add(t.id)

      for (const depId of t.dependencies) {
        const dep = this.tasks.get(depId)
        if (dep) visit(dep)
      }

      chain.push(t)
    }

    visit(task)
    return chain
  }

  /**
   * 删除任务
   */
  deleteTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    // 检查是否有其他任务依赖此任务
    if (task.blockedBy.length > 0) {
      throw new Error(`无法删除：有 ${task.blockedBy.length} 个任务依赖此任务`)
    }

    // 从依赖任务中移除
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId)
      if (dep) {
        dep.blockedBy = dep.blockedBy.filter(bid => bid !== id)
      }
    }

    this.tasks.delete(id)
    this.markDirty()
    logger.info(`删除任务: ${id}`)
    return true
  }

  /**
   * 清空所有任务
   */
  clearTasks(): void {
    this.tasks.clear()
    this.markDirty()
    logger.info('已清空所有任务')
  }

  /**
   * 生成任务摘要
   */
  getSummary(): string {
    const tasks = this.getAllTasks()
    if (tasks.length === 0) {
      return '暂无任务'
    }

    const pending = tasks.filter(t => t.status === 'pending')
    const blocked = tasks.filter(t => t.status === 'blocked')
    const inProgress = tasks.filter(t => t.status === 'in_progress')
    const completed = tasks.filter(t => t.status === 'completed')
    const failed = tasks.filter(t => t.status === 'failed')

    const lines = [
      '# 任务状态概览',
      '',
      `- 总计: ${tasks.length}`,
      `- 进行中: ${inProgress.length}`,
      `- 待处理: ${pending.length}`,
      `- 被阻塞: ${blocked.length}`,
      `- 已完成: ${completed.length}`,
      `- 已失败: ${failed.length}`,
      '',
    ]

    if (inProgress.length > 0) {
      lines.push('## 进行中')
      for (const t of inProgress) {
        lines.push(`- [→] **${t.title}** (${t.id}) - ${t.assignee || '未分配'}`)
      }
      lines.push('')
    }

    if (blocked.length > 0) {
      lines.push('## 被阻塞')
      for (const t of blocked) {
        const deps = t.dependencies.map(d => {
          const dep = this.tasks.get(d)
          return dep ? dep.title : d
        }).join(', ')
        lines.push(`- [⏸] **${t.title}** (${t.id}) - 等待: ${deps}`)
      }
      lines.push('')
    }

    if (pending.length > 0) {
      lines.push('## 待处理')
      for (const t of pending) {
        const priority = t.priority === 'normal' ? '' : ` [${t.priority}]`
        lines.push(`- [ ] **${t.title}** (${t.id})${priority}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  // === 私有方法 ===

  /**
   * 解锁依赖此任务的被阻塞任务
   */
  private unblockDependentTasks(completedId: string): void {
    const task = this.tasks.get(completedId)
    if (!task) return

    for (const blockedId of task.blockedBy) {
      const blockedTask = this.tasks.get(blockedId)
      if (!blockedTask || blockedTask.status !== 'blocked') continue

      // 检查所有依赖是否都已完成
      const allDepsCompleted = blockedTask.dependencies.every(depId => {
        const dep = this.tasks.get(depId)
        return dep && dep.status === 'completed'
      })

      if (allDepsCompleted) {
        blockedTask.status = 'pending'
        blockedTask.updatedAt = Date.now()
        logger.info(`解锁任务: ${blockedId}`)
      }
    }
  }

  /**
   * 检测是否会创建循环依赖
   */
  private wouldCreateCycle(taskId: string, dependencies: string[]): boolean {
    const visited = new Set<string>()
    const stack = new Set<string>()

    const hasCycle = (id: string): boolean => {
      if (stack.has(id)) return true
      if (visited.has(id)) return false

      visited.add(id)
      stack.add(id)

      const task = this.tasks.get(id)
      if (task) {
        for (const depId of task.dependencies) {
          if (hasCycle(depId)) return true
        }
      }

      stack.delete(id)
      return false
    }

    // 检查从新任务开始的依赖链
    for (const depId of dependencies) {
      if (hasCycle(depId)) return true
      // 也检查反向：从依赖任务到新任务
      const depTask = this.tasks.get(depId)
      if (depTask && depTask.blockedBy.some(bid => bid === taskId || this.wouldCreateCycle(taskId, [bid]))) {
        return true
      }
    }

    return false
  }

  /**
   * 验证状态转换
   */
  private isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
    const validTransitions: Record<TaskStatus, TaskStatus[]> = {
      pending: ['in_progress', 'cancelled'],
      blocked: ['pending', 'cancelled'],
      in_progress: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: ['pending'], // 允许重试
      cancelled: ['pending'], // 允许恢复
    }

    return validTransitions[from]?.includes(to) || false
  }

  /**
   * 生成任务 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).slice(2, 5)
    return `task-${timestamp}-${random}`
  }

  /**
   * 标记需要保存
   */
  private markDirty(): void {
    this.dirty = true
  }

  /**
   * 启动自动保存
   */
  private startAutoSave(): void {
    if (this.saveTimer) return

    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.save().catch(err => logger.error('自动保存失败:', err))
      }
    }, this.config.autoSaveInterval)
  }

  /**
   * 停止自动保存
   */
  private stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer)
      this.saveTimer = null
    }
  }

  /**
   * 保存任务图到文件
   */
  async save(): Promise<void> {
    const data = {
      version: 1,
      tasks: Array.from(this.tasks.values()),
      savedAt: Date.now(),
    }

    await fs.writeFile(
      this.config.graphPath,
      JSON.stringify(data, null, 2),
      'utf-8'
    )

    this.dirty = false
    logger.debug('任务图已保存')
  }

  /**
   * 从文件加载任务图
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.graphPath, 'utf-8')
      const data = JSON.parse(content)

      if (data.version === 1 && Array.isArray(data.tasks)) {
        this.tasks.clear()
        for (const task of data.tasks) {
          this.tasks.set(task.id, task)
        }
        logger.info(`加载了 ${this.tasks.size} 个任务`)
      }
    } catch (error) {
      // 文件不存在或解析失败，使用空任务图
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('加载任务图失败:', error)
      }
    }
  }

  /**
   * 关闭任务系统
   */
  async shutdown(): Promise<void> {
    this.stopAutoSave()
    if (this.dirty) {
      await this.save()
    }
    logger.info('任务系统已关闭')
  }
}

// 默认实例
let defaultSystem: TaskSystem | null = null

/**
 * 获取默认任务系统
 */
export function getTaskSystem(): TaskSystem {
  if (!defaultSystem) {
    defaultSystem = new TaskSystem()
  }
  return defaultSystem
}

/**
 * 重置任务系统
 */
export function resetTaskSystem(): void {
  defaultSystem = null
}
