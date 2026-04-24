// src/tools/background-tasks.ts
// s08 Background Tasks - 后台任务与通知队列

import { ChildProcess, spawn } from 'child_process'
import { createLogger } from '../utils/logger'
import { EventEmitter } from 'events'

const logger = createLogger('background-tasks')

/**
 * 后台任务状态
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * 后台任务定义
 */
export interface BackgroundTask {
  /** 任务 ID */
  id: string
  /** 任务名称 */
  name: string
  /** 命令 */
  command: string
  /** 参数 */
  args: string[]
  /** 当前工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 状态 */
  status: BackgroundTaskStatus
  /** 进程 */
  process?: ChildProcess
  /** PID */
  pid?: number
  /** 开始时间 */
  startedAt: number
  /** 结束时间 */
  endedAt?: number
  /** 退出码 */
  exitCode?: number
  /** 标准输出 */
  stdout: string[]
  /** 标准错误 */
  stderr: string[]
  /** 完成回调 */
  onComplete?: (result: BackgroundTaskResult) => void
  /** 元数据 */
  metadata?: Record<string, unknown>
}

/**
 * 后台任务结果
 */
export interface BackgroundTaskResult {
  /** 任务 ID */
  id: string
  /** 任务名称 */
  name: string
  /** 状态 */
  status: BackgroundTaskStatus
  /** 退出码 */
  exitCode?: number
  /** 执行时间（毫秒） */
  duration: number
  /** 标准输出 */
  stdout: string
  /** 标准错误 */
  stderr: string
  /** 元数据 */
  metadata?: Record<string, unknown>
}

/**
 * 通知消息
 */
export interface Notification {
  /** 通知 ID */
  id: string
  /** 通知类型 */
  type: 'task_completed' | 'task_failed' | 'task_started' | 'reminder' | 'alert'
  /** 通知标题 */
  title: string
  /** 通知内容 */
  content: string
  /** 创建时间 */
  createdAt: number
  /** 是否已读 */
  read: boolean
  /** 关联的任务 ID */
  taskId?: string
  /** 优先级 */
  priority: 'low' | 'normal' | 'high'
}

/**
 * BackgroundTaskManager 配置
 */
export interface BackgroundTaskManagerConfig {
  /** 最大并发任务数 */
  maxConcurrent: number
  /** 输出缓冲区大小（行数） */
  outputBufferLines: number
  /** 通知队列最大长度 */
  maxNotifications: number
}

const DEFAULT_CONFIG: BackgroundTaskManagerConfig = {
  maxConcurrent: 5,
  outputBufferLines: 100,
  maxNotifications: 100,
}

/**
 * BackgroundTaskManager - 后台任务管理器
 *
 * 特点：
 * - 非阻塞执行
 * - 通知队列
 * - 输出捕获
 * - 进程管理
 */
export class BackgroundTaskManager extends EventEmitter {
  private config: BackgroundTaskManagerConfig
  private tasks: Map<string, BackgroundTask> = new Map()
  private notifications: Notification[] = []
  private taskCounter = 0

  constructor(config: Partial<BackgroundTaskManagerConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 启动后台任务
   */
  startTask(
    name: string,
    command: string,
    args: string[] = [],
    options: {
      cwd?: string
      env?: Record<string, string>
      onComplete?: (result: BackgroundTaskResult) => void
      metadata?: Record<string, unknown>
    } = {}
  ): BackgroundTask {
    // 检查并发限制
    const running = this.getRunningTasks()
    if (running.length >= this.config.maxConcurrent) {
      throw new Error(`已达到最大并发任务数 (${this.config.maxConcurrent})`)
    }

    const id = this.generateId()

    const task: BackgroundTask = {
      id,
      name,
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      status: 'running',
      startedAt: Date.now(),
      stdout: [],
      stderr: [],
      onComplete: options.onComplete,
      metadata: options.metadata,
    }

    // 启动进程
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: false,
      shell: true,
    })

    task.process = proc
    task.pid = proc.pid

    // 捕获输出
    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          task.stdout.push(line)
          // 限制缓冲区大小
          if (task.stdout.length > this.config.outputBufferLines) {
            task.stdout.shift()
          }
        }
      }
      this.emit('output', { taskId: id, type: 'stdout', line: data.toString() })
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) {
          task.stderr.push(line)
          // 限制缓冲区大小
          if (task.stderr.length > this.config.outputBufferLines) {
            task.stderr.shift()
          }
        }
      }
      this.emit('output', { taskId: id, type: 'stderr', line: data.toString() })
    })

    // 处理完成
    proc.on('close', (code) => {
      task.status = code === 0 ? 'completed' : 'failed'
      task.endedAt = Date.now()
      task.exitCode = code ?? undefined

      const result = this.createResult(task)

      // 添加通知
      this.addNotification({
        type: task.status === 'completed' ? 'task_completed' : 'task_failed',
        title: `任务${task.status === 'completed' ? '完成' : '失败'}: ${name}`,
        content: `命令: ${command} ${args.join(' ')}\n退出码: ${code}\n执行时间: ${result.duration}ms`,
        taskId: id,
        priority: task.status === 'completed' ? 'low' : 'high',
      })

      // 触发回调
      if (task.onComplete) {
        try {
          task.onComplete(result)
        } catch (err) {
          logger.error(`任务回调失败: ${id}`, err)
        }
      }

      this.emit('completed', result)
      logger.info(`后台任务结束: ${id} (${task.status})`)
    })

    proc.on('error', (err) => {
      task.status = 'failed'
      task.endedAt = Date.now()
      task.stderr.push(`进程错误: ${err.message}`)

      this.addNotification({
        type: 'task_failed',
        title: `任务错误: ${name}`,
        content: `错误: ${err.message}`,
        taskId: id,
        priority: 'high',
      })

      this.emit('error', { taskId: id, error: err })
      logger.error(`后台任务错误: ${id}`, err)
    })

    this.tasks.set(id, task)

    // 添加启动通知
    this.addNotification({
      type: 'task_started',
      title: `任务启动: ${name}`,
      content: `命令: ${command} ${args.join(' ')}\nPID: ${proc.pid}`,
      taskId: id,
      priority: 'low',
    })

    logger.info(`启动后台任务: ${id} - ${name} (PID: ${proc.pid})`)
    this.emit('started', { taskId: id, name })

    return task
  }

  /**
   * 停止后台任务
   */
  stopTask(id: string, force = false): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'running') {
      return false
    }

    if (task.process) {
      if (force) {
        task.process.kill('SIGKILL')
      } else {
        task.process.kill('SIGTERM')
      }
      task.status = 'cancelled'
      task.endedAt = Date.now()

      this.addNotification({
        type: 'task_failed',
        title: `任务已取消: ${task.name}`,
        content: `ID: ${id}`,
        taskId: id,
        priority: 'normal',
      })

      logger.info(`停止后台任务: ${id}`)
      this.emit('cancelled', { taskId: id })
      return true
    }

    return false
  }

  /**
   * 获取任务
   */
  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): BackgroundTask[] {
    return this.getAllTasks().filter(t => t.status === 'running')
  }

  /**
   * 获取已完成的任务
   */
  getCompletedTasks(): BackgroundTask[] {
    return this.getAllTasks().filter(t => t.status === 'completed' || t.status === 'failed')
  }

  /**
   * 获取任务输出
   */
  getTaskOutput(id: string): { stdout: string; stderr: string } | null {
    const task = this.tasks.get(id)
    if (!task) return null

    return {
      stdout: task.stdout.join('\n'),
      stderr: task.stderr.join('\n'),
    }
  }

  /**
   * 添加通知
   */
  addNotification(notification: Omit<Notification, 'id' | 'createdAt' | 'read'>): Notification {
    const n: Notification = {
      ...notification,
      id: this.generateNotificationId(),
      createdAt: Date.now(),
      read: false,
    }

    this.notifications.unshift(n)

    // 限制通知数量
    if (this.notifications.length > this.config.maxNotifications) {
      this.notifications = this.notifications.slice(0, this.config.maxNotifications)
    }

    this.emit('notification', n)
    return n
  }

  /**
   * 获取未读通知
   */
  getUnreadNotifications(): Notification[] {
    return this.notifications.filter(n => !n.read)
  }

  /**
   * 获取所有通知
   */
  getAllNotifications(): Notification[] {
    return this.notifications
  }

  /**
   * 标记通知为已读
   */
  markAsRead(id: string): boolean {
    const notification = this.notifications.find(n => n.id === id)
    if (notification) {
      notification.read = true
      return true
    }
    return false
  }

  /**
   * 标记所有通知为已读
   */
  markAllAsRead(): void {
    for (const n of this.notifications) {
      n.read = true
    }
  }

  /**
   * 清除已读通知
   */
  clearReadNotifications(): void {
    this.notifications = this.notifications.filter(n => !n.read)
  }

  /**
   * 清理已完成任务
   */
  cleanupCompletedTasks(maxAge = 3600000): number {
    const now = Date.now()
    let cleaned = 0

    for (const [id, task] of this.tasks) {
      if (
        (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') &&
        task.endedAt &&
        now - task.endedAt > maxAge
      ) {
        this.tasks.delete(id)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.info(`清理了 ${cleaned} 个已完成任务`)
    }
    return cleaned
  }

  /**
   * 停止所有任务
   */
  stopAll(): void {
    for (const task of this.getRunningTasks()) {
      this.stopTask(task.id)
    }
    logger.info('已停止所有后台任务')
  }

  /**
   * 生成任务摘要
   */
  getSummary(): string {
    const running = this.getRunningTasks()
    const completed = this.getCompletedTasks()
    const unread = this.getUnreadNotifications()

    const lines = [
      '## 后台任务状态',
      '',
      `- 运行中: ${running.length}`,
      `- 已完成: ${completed.length}`,
      `- 未读通知: ${unread.length}`,
      '',
    ]

    if (running.length > 0) {
      lines.push('### 运行中')
      for (const t of running) {
        const duration = Math.round((Date.now() - t.startedAt) / 1000)
        lines.push(`- [→] **${t.name}** (${t.id}) - ${duration}s - PID: ${t.pid}`)
      }
      lines.push('')
    }

    if (unread.length > 0) {
      lines.push('### 未读通知')
      for (const n of unread.slice(0, 5)) {
        const icon = n.type === 'task_completed' ? '✓' :
                     n.type === 'task_failed' ? '✗' : '•'
        lines.push(`- [${icon}] ${n.title}`)
      }
      if (unread.length > 5) {
        lines.push(`- ... 还有 ${unread.length - 5} 条通知`)
      }
    }

    return lines.join('\n')
  }

  // === 私有方法 ===

  private generateId(): string {
    this.taskCounter++
    const timestamp = Date.now().toString(36)
    return `bg-${timestamp}-${this.taskCounter.toString(36)}`
  }

  private generateNotificationId(): string {
    return `notif-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
  }

  private createResult(task: BackgroundTask): BackgroundTaskResult {
    return {
      id: task.id,
      name: task.name,
      status: task.status,
      exitCode: task.exitCode,
      duration: task.endedAt ? task.endedAt - task.startedAt : 0,
      stdout: task.stdout.join('\n'),
      stderr: task.stderr.join('\n'),
      metadata: task.metadata,
    }
  }
}

// 默认实例
let defaultManager: BackgroundTaskManager | null = null

/**
 * 获取默认后台任务管理器
 */
export function getBackgroundTaskManager(): BackgroundTaskManager {
  if (!defaultManager) {
    defaultManager = new BackgroundTaskManager()
  }
  return defaultManager
}

/**
 * 重置后台任务管理器
 */
export function resetBackgroundTaskManager(): void {
  if (defaultManager) {
    defaultManager.stopAll()
  }
  defaultManager = null
}
