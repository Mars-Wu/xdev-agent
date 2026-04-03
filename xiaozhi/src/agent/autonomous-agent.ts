// src/agent/autonomous-agent.ts
// s11 Autonomous Agents - 自主认领任务

import { EventEmitter } from 'events'
import { createLogger } from '../utils/logger'
import { InProcessAgent, AgentType, AgentConfig, AgentStatus } from './in-process-agent'
import { getTaskSystem, Task, TaskStatus } from '../tools/task-system'

const logger = createLogger('autonomous-agent')

/**
 * 自主 Agent 配置
 */
export interface AutonomousAgentConfig extends AgentConfig {
  /** 技能标签（用于匹配任务） */
  skills?: string[]
  /** 最大并发任务数 */
  maxConcurrentTasks?: number
  /** 任务轮询间隔（毫秒） */
  pollInterval?: number
  /** 自主模式 */
  autonomous?: boolean
}

/**
 * 任务匹配规则
 */
export interface TaskMatchingRule {
  /** 匹配的字段 */
  field: 'tags' | 'title' | 'description' | 'assignee'
  /** 匹配模式 */
  pattern: string | RegExp
  /** 优先级调整 */
  priorityBoost?: number
}

/**
 * AutonomousAgent - 自主认领任务的 Agent
 *
 * 特点：
 * - 从任务看板自主认领任务
 * - 根据技能标签匹配任务
 * - 支持任务完成通知
 */
export class AutonomousAgent extends EventEmitter {
  private config: AutonomousAgentConfig
  private agent: InProcessAgent
  private currentTask: Task | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private running = false

  constructor(config: AutonomousAgentConfig) {
    super()
    this.config = {
      maxConcurrentTasks: 1,
      pollInterval: 5000,
      autonomous: true,
      ...config,
    }

    this.agent = new InProcessAgent(config)
  }

  /**
   * 启动自主模式
   */
  async start(): Promise<void> {
    if (this.running) return

    this.running = true
    this.pollTimer = setInterval(() => {
      this.pollTasks().catch(err => logger.error('轮询任务失败:', err))
    }, this.config.pollInterval)

    logger.info(`自主 Agent 启动: ${this.config.name}`)
    this.emit('started')

    // 立即执行一次轮询
    await this.pollTasks()
  }

  /**
   * 停止自主模式
   */
  async stop(): Promise<void> {
    this.running = false

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // 如果有正在进行的任务，标记为暂停
    if (this.currentTask) {
      const taskSystem = getTaskSystem()
      taskSystem.updateTaskStatus(this.currentTask.id, 'pending')
      this.currentTask = null
    }

    logger.info(`自主 Agent 停止: ${this.config.name}`)
    this.emit('stopped')
  }

  /**
   * 轮询可执行任务
   */
  private async pollTasks(): Promise<void> {
    if (!this.running || this.currentTask) return

    const taskSystem = getTaskSystem()
    const executableTasks = taskSystem.getExecutableTasks()

    // 过滤匹配的任务
    const matchingTasks = executableTasks.filter(task => this.matchesTask(task))

    if (matchingTasks.length === 0) return

    // 选择优先级最高的任务
    const task = this.selectBestTask(matchingTasks)
    if (!task) return

    // 尝试认领任务
    await this.claimTask(task)
  }

  /**
   * 认领任务
   */
  private async claimTask(task: Task): Promise<boolean> {
    const taskSystem = getTaskSystem()

    // 尝试更新任务状态
    const updated = taskSystem.startTask(task.id, this.config.name)
    if (!updated) {
      logger.debug(`任务已被其他 Agent 认领: ${task.id}`)
      return false
    }

    this.currentTask = task
    logger.info(`认领任务: ${task.id} - ${task.title}`)
    this.emit('task_claimed', task)

    // 异步执行任务
    this.executeTask(task).catch(err => {
      logger.error(`任务执行失败: ${task.id}`, err)
    })

    return true
  }

  /**
   * 执行任务
   */
  private async executeTask(task: Task): Promise<void> {
    const taskSystem = getTaskSystem()

    try {
      // 构建任务提示
      const prompt = this.buildTaskPrompt(task)

      // 调用 Agent 执行
      const result = await this.agent.execute(prompt)

      // 标记任务完成
      taskSystem.completeTask(task.id, result)
      logger.info(`任务完成: ${task.id}`)
      this.emit('task_completed', { task, result })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      // 标记任务失败
      taskSystem.failTask(task.id, errorMsg)
      logger.error(`任务失败: ${task.id} - ${errorMsg}`)
      this.emit('task_failed', { task, error: errorMsg })
    } finally {
      this.currentTask = null

      // 继续轮询下一个任务
      if (this.running) {
        setTimeout(() => {
          this.pollTasks().catch(err => logger.error('轮询任务失败:', err))
        }, 100)
      }
    }
  }

  /**
   * 构建任务提示
   */
  private buildTaskPrompt(task: Task): string {
    const lines = [
      `# 任务: ${task.title}`,
      '',
      `**任务 ID**: ${task.id}`,
      `**优先级**: ${task.priority}`,
      '',
      '## 描述',
      task.description || '无详细描述',
      '',
    ]

    if (task.tags.length > 0) {
      lines.push('## 标签')
      lines.push(task.tags.map(t => `- ${t}`).join('\n'))
      lines.push('')
    }

    if (task.metadata) {
      lines.push('## 附加信息')
      lines.push('```json')
      lines.push(JSON.stringify(task.metadata, null, 2))
      lines.push('```')
      lines.push('')
    }

    lines.push('## 要求')
    lines.push('请完成上述任务，完成后提供详细的结果说明。')

    return lines.join('\n')
  }

  /**
   * 检查任务是否匹配
   */
  private matchesTask(task: Task): boolean {
    // 如果任务已指定执行者，检查是否是自己
    if (task.assignee && task.assignee !== this.config.name) {
      return false
    }

    // 如果有技能标签，检查匹配
    if (this.config.skills && this.config.skills.length > 0) {
      // 检查任务标签是否匹配技能
      const hasMatchingTag = task.tags.some(tag =>
        this.config.skills!.some(skill =>
          skill.toLowerCase() === tag.toLowerCase()
        )
      )

      if (!hasMatchingTag) {
        return false
      }
    }

    return true
  }

  /**
   * 选择最佳任务
   */
  private selectBestTask(tasks: Task[]): Task | null {
    if (tasks.length === 0) return null

    // 按优先级排序
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 }

    const sorted = tasks.sort((a, b) => {
      const pa = priorityOrder[a.priority]
      const pb = priorityOrder[b.priority]
      if (pa !== pb) return pa - pb
      return a.createdAt - b.createdAt
    })

    return sorted[0]
  }

  /**
   * 获取当前任务
   */
  getCurrentTask(): Task | null {
    return this.currentTask
  }

  /**
   * 获取状态
   */
  getStatus(): AgentStatus {
    return this.currentTask ? 'working' : 'idle'
  }

  /**
   * 获取配置
   */
  getConfig(): AutonomousAgentConfig {
    return this.config
  }
}

/**
 * 自主 Agent 管理器
 */
export class AutonomousAgentManager {
  private agents: Map<string, AutonomousAgent> = new Map()

  /**
   * 注册自主 Agent
   */
  registerAgent(config: AutonomousAgentConfig): AutonomousAgent {
    if (this.agents.has(config.name)) {
      throw new Error(`Agent 已存在: ${config.name}`)
    }

    const agent = new AutonomousAgent(config)
    this.agents.set(config.name, agent)

    logger.info(`注册自主 Agent: ${config.name}`)
    return agent
  }

  /**
   * 获取 Agent
   */
  getAgent(name: string): AutonomousAgent | undefined {
    return this.agents.get(name)
  }

  /**
   * 启动所有 Agent
   */
  async startAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.start()
    }
  }

  /**
   * 停止所有 Agent
   */
  async stopAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.stop()
    }
  }

  /**
   * 获取所有 Agent 状态
   */
  getAllStatus(): Record<string, { status: AgentStatus; currentTask: Task | null }> {
    const result: Record<string, { status: AgentStatus; currentTask: Task | null }> = {}

    for (const [name, agent] of this.agents) {
      result[name] = {
        status: agent.getStatus(),
        currentTask: agent.getCurrentTask(),
      }
    }

    return result
  }

  /**
   * 取消注册 Agent
   */
  async unregisterAgent(name: string): Promise<boolean> {
    const agent = this.agents.get(name)
    if (!agent) return false

    await agent.stop()
    this.agents.delete(name)
    logger.info(`取消注册自主 Agent: ${name}`)

    return true
  }
}

// 默认实例
let defaultManager: AutonomousAgentManager | null = null

/**
 * 获取默认管理器
 */
export function getAutonomousAgentManager(): AutonomousAgentManager {
  if (!defaultManager) {
    defaultManager = new AutonomousAgentManager()
  }
  return defaultManager
}

/**
 * 重置管理器
 */
export function resetAutonomousAgentManager(): void {
  if (defaultManager) {
    defaultManager.stopAll().catch(() => {})
  }
  defaultManager = null
}
