// src/tools/todo-manager.ts
// s03 TodoWrite - 任务进度追踪与提醒

import { createLogger } from '../utils/logger'

const logger = createLogger('todo-manager')

/**
 * 任务状态
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * 任务定义
 */
export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  createdAt: number
  updatedAt: number
  completedAt?: number
  metadata?: Record<string, unknown>
}

/**
 * TodoManager 配置
 */
export interface TodoManagerConfig {
  /** 最大轮数无更新后触发提醒 */
  maxRoundsWithoutUpdate: number
  /** 最大任务数 */
  maxTodos: number
}

const DEFAULT_CONFIG: TodoManagerConfig = {
  maxRoundsWithoutUpdate: 3,
  maxTodos: 50,
}

/**
 * TodoManager - 任务进度管理器
 *
 * 特点：
 * - 同一时间只能有一个 in_progress 任务
 * - 超过 N 轮无更新时注入提醒
 * - 支持任务依赖（未来扩展）
 */
export class TodoManager {
  private todos: Map<string, TodoItem> = new Map()
  private roundsSinceLastUpdate: number = 0
  private config: TodoManagerConfig
  private currentInProgressId: string | null = null

  constructor(config: Partial<TodoManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 创建新任务
   */
  createTodo(content: string, metadata?: Record<string, unknown>): TodoItem {
    const id = this.generateId()

    // 检查最大任务数
    if (this.todos.size >= this.config.maxTodos) {
      // 清理已完成的旧任务
      this.cleanupCompleted()
      if (this.todos.size >= this.config.maxTodos) {
        throw new Error(`任务数量已达上限 (${this.config.maxTodos})`)
      }
    }

    const todo: TodoItem = {
      id,
      content,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata,
    }

    this.todos.set(id, todo)
    this.resetRoundCounter()
    logger.debug(`创建任务: ${id} - ${content}`)

    return todo
  }

  /**
   * 更新任务状态
   */
  updateTodo(id: string, status: TodoStatus): TodoItem | null {
    const todo = this.todos.get(id)
    if (!todo) {
      logger.warn(`任务不存在: ${id}`)
      return null
    }

    // 检查 in_progress 约束
    if (status === 'in_progress') {
      if (this.currentInProgressId && this.currentInProgressId !== id) {
        // 自动将当前 in_progress 任务改为 pending
        const currentTodo = this.todos.get(this.currentInProgressId)
        if (currentTodo && currentTodo.status === 'in_progress') {
          currentTodo.status = 'pending'
          currentTodo.updatedAt = Date.now()
          logger.info(`自动暂停任务: ${this.currentInProgressId}`)
        }
      }
      this.currentInProgressId = id
    } else if (status === 'completed') {
      if (this.currentInProgressId === id) {
        this.currentInProgressId = null
      }
      todo.completedAt = Date.now()
    } else if (status === 'pending' && this.currentInProgressId === id) {
      this.currentInProgressId = null
    }

    todo.status = status
    todo.updatedAt = Date.now()
    this.resetRoundCounter()
    logger.info(`更新任务: ${id} -> ${status}`)

    return todo
  }

  /**
   * 开始任务（快捷方法）
   */
  startTodo(id: string): TodoItem | null {
    return this.updateTodo(id, 'in_progress')
  }

  /**
   * 完成任务（快捷方法）
   */
  completeTodo(id: string): TodoItem | null {
    return this.updateTodo(id, 'completed')
  }

  /**
   * 获取任务
   */
  getTodo(id: string): TodoItem | undefined {
    return this.todos.get(id)
  }

  /**
   * 获取所有任务
   */
  getAllTodos(): TodoItem[] {
    return Array.from(this.todos.values())
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 获取当前进行中的任务
   */
  getCurrentTodo(): TodoItem | null {
    if (!this.currentInProgressId) return null
    return this.todos.get(this.currentInProgressId) || null
  }

  /**
   * 获取待处理任务
   */
  getPendingTodos(): TodoItem[] {
    return this.getAllTodos().filter(t => t.status === 'pending')
  }

  /**
   * 获取已完成任务
   */
  getCompletedTodos(): TodoItem[] {
    return this.getAllTodos().filter(t => t.status === 'completed')
  }

  /**
   * 增加轮数计数
   * @returns 是否需要提醒
   */
  incrementRound(): boolean {
    this.roundsSinceLastUpdate++
    const needsNag = this.roundsSinceLastUpdate >= this.config.maxRoundsWithoutUpdate
    if (needsNag) {
      logger.debug(`触发任务提醒: ${this.roundsSinceLastUpdate} 轮无更新`)
    }
    return needsNag
  }

  /**
   * 重置轮数计数
   */
  resetRoundCounter(): void {
    this.roundsSinceLastUpdate = 0
  }

  /**
   * 获取提醒消息
   */
  getNagMessage(): string | null {
    const current = this.getCurrentTodo()
    if (!current) {
      // 没有进行中的任务，检查是否有待处理的
      const pending = this.getPendingTodos()
      if (pending.length > 0) {
        return `你有 ${pending.length} 个待处理的任务。使用 todo 工具查看或开始一个任务。`
      }
      return null
    }

    return `当前任务「${current.content}」已 ${this.roundsSinceLastUpdate} 轮未更新。如果已完成，请标记为 completed。`
  }

  /**
   * 生成任务摘要
   */
  getSummary(): string {
    const todos = this.getAllTodos()
    if (todos.length === 0) {
      return '暂无任务'
    }

    const pending = todos.filter(t => t.status === 'pending')
    const inProgress = todos.filter(t => t.status === 'in_progress')
    const completed = todos.filter(t => t.status === 'completed')

    const lines = ['## 任务状态', '']

    if (inProgress.length > 0) {
      lines.push('### 进行中')
      for (const t of inProgress) {
        lines.push(`- [→] ${t.content} (${t.id})`)
      }
      lines.push('')
    }

    if (pending.length > 0) {
      lines.push('### 待处理')
      for (const t of pending) {
        lines.push(`- [ ] ${t.content} (${t.id})`)
      }
      lines.push('')
    }

    if (completed.length > 0) {
      lines.push('### 已完成')
      for (const t of completed) {
        lines.push(`- [✓] ${t.content} (${t.id})`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 清理已完成的任务
   */
  cleanupCompleted(): number {
    let cleaned = 0
    const now = Date.now()
    const oneHourAgo = now - 3600000

    for (const [id, todo] of this.todos) {
      if (todo.status === 'completed' && todo.completedAt && todo.completedAt < oneHourAgo) {
        this.todos.delete(id)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.info(`清理了 ${cleaned} 个已完成任务`)
    }
    return cleaned
  }

  /**
   * 清空所有任务
   */
  clear(): void {
    this.todos.clear()
    this.currentInProgressId = null
    this.roundsSinceLastUpdate = 0
    logger.info('已清空所有任务')
  }

  /**
   * 生成任务 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).slice(2, 5)
    return `todo-${timestamp}-${random}`
  }

  /**
   * 导出任务列表（用于持久化）
   */
  export(): TodoItem[] {
    return this.getAllTodos()
  }

  /**
   * 导入任务列表
   */
  import(todos: TodoItem[]): void {
    this.todos.clear()
    this.currentInProgressId = null

    for (const todo of todos) {
      this.todos.set(todo.id, todo)
      if (todo.status === 'in_progress') {
        this.currentInProgressId = todo.id
      }
    }

    logger.info(`导入了 ${todos.length} 个任务`)
  }
}

// 默认实例
let defaultManager: TodoManager | null = null

/**
 * 获取默认 TodoManager
 */
export function getTodoManager(): TodoManager {
  if (!defaultManager) {
    defaultManager = new TodoManager()
  }
  return defaultManager
}

/**
 * 重置默认 TodoManager
 */
export function resetTodoManager(): void {
  defaultManager = null
}
