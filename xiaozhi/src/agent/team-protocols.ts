// src/agent/team-protocols.ts
// s10 Team Protocols - 团队协议与请求-响应 FSM

import { EventEmitter } from 'events'
import { createLogger } from '../utils/logger'
import * as fs from 'fs/promises'
import * as path from 'path'

const logger = createLogger('team-protocols')

/**
 * 协议类型
 */
export enum ProtocolType {
  /** 关闭请求 */
  SHUTDOWN = 'shutdown',
  /** 计划审批 */
  PLAN_APPROVAL = 'plan_approval',
  /** 任务分配 */
  TASK_ASSIGNMENT = 'task_assignment',
  /** 状态同步 */
  STATUS_SYNC = 'status_sync',
}

/**
 * 协议状态
 */
export enum ProtocolState {
  /** 等待请求 */
  IDLE = 'idle',
  /** 等待响应 */
  PENDING = 'pending',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 已超时 */
  TIMEOUT = 'timeout',
  /** 已取消 */
  CANCELLED = 'cancelled',
}

/**
 * 协议请求
 */
export interface ProtocolRequest {
  /** 请求 ID */
  id: string
  /** 协议类型 */
  type: ProtocolType
  /** 发送者 */
  from: string
  /** 接收者 */
  to: string
  /** 请求内容 */
  content: unknown
  /** 创建时间 */
  createdAt: number
  /** 超时时间（毫秒） */
  timeout: number
  /** 状态 */
  state: ProtocolState
  /** 响应 */
  response?: ProtocolResponse
}

/**
 * 协议响应
 */
export interface ProtocolResponse {
  /** 请求 ID */
  requestId: string
  /** 是否批准 */
  approved: boolean
  /** 响应内容 */
  content?: unknown
  /** 反馈信息 */
  feedback?: string
  /** 响应时间 */
  respondedAt: number
}

/**
 * 协议处理器
 */
export type ProtocolHandler = (
  request: ProtocolRequest
) => Promise<ProtocolResponse>

/**
 * TeamProtocols 配置
 */
export interface TeamProtocolsConfig {
  /** 默认超时时间（毫秒） */
  defaultTimeout: number
  /** 最大等待请求数 */
  maxPendingRequests: number
  /** 请求存储目录 */
  storageDir?: string
}

const DEFAULT_CONFIG: TeamProtocolsConfig = {
  defaultTimeout: 60000, // 1分钟
  maxPendingRequests: 100,
}

/**
 * TeamProtocols - 团队协议管理器
 *
 * 实现请求-响应 FSM：
 * - shutdown_request / shutdown_response
 * - plan_approval_request / plan_approval_response
 * - task_assignment / task_result
 */
export class TeamProtocols extends EventEmitter {
  private config: TeamProtocolsConfig
  private pendingRequests: Map<string, ProtocolRequest> = new Map()
  private handlers: Map<ProtocolType, ProtocolHandler> = new Map()
  private requestCounter = 0

  constructor(config: Partial<TeamProtocolsConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 发送协议请求
   */
  async sendRequest(
    type: ProtocolType,
    from: string,
    to: string,
    content: unknown,
    timeout?: number
  ): Promise<ProtocolResponse> {
    const request: ProtocolRequest = {
      id: this.generateRequestId(),
      type,
      from,
      to,
      content,
      createdAt: Date.now(),
      timeout: timeout || this.config.defaultTimeout,
      state: ProtocolState.PENDING,
    }

    // 检查最大请求数
    if (this.pendingRequests.size >= this.config.maxPendingRequests) {
      this.cleanupExpiredRequests()
      if (this.pendingRequests.size >= this.config.maxPendingRequests) {
        throw new Error('请求数量已达上限')
      }
    }

    this.pendingRequests.set(request.id, request)
    this.emit('request', request)

    logger.info(`发送协议请求: ${request.id} (${type}) ${from} -> ${to}`)

    // 等待响应
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        request.state = ProtocolState.TIMEOUT
        this.pendingRequests.delete(request.id)
        this.emit('timeout', request)
        reject(new Error(`请求超时: ${request.id}`))
      }, request.timeout)

      this.once(`response:${request.id}`, (response: ProtocolResponse) => {
        clearTimeout(timeoutId)
        request.state = ProtocolState.COMPLETED
        request.response = response
        this.pendingRequests.delete(request.id)
        this.emit('completed', { request, response })
        resolve(response)
      })
    })
  }

  /**
   * 发送协议响应
   */
  sendResponse(
    requestId: string,
    approved: boolean,
    content?: unknown,
    feedback?: string
  ): boolean {
    const request = this.pendingRequests.get(requestId)
    if (!request) {
      logger.warn(`请求不存在或已处理: ${requestId}`)
      return false
    }

    const response: ProtocolResponse = {
      requestId,
      approved,
      content,
      feedback,
      respondedAt: Date.now(),
    }

    request.response = response
    this.emit(`response:${requestId}`, response)
    logger.info(`发送协议响应: ${requestId} (${approved ? '批准' : '拒绝'})`)

    return true
  }

  /**
   * 注册协议处理器
   */
  registerHandler(type: ProtocolType, handler: ProtocolHandler): void {
    this.handlers.set(type, handler)
    logger.debug(`注册协议处理器: ${type}`)
  }

  /**
   * 处理收到的请求
   */
  async handleRequest(request: ProtocolRequest): Promise<ProtocolResponse> {
    const handler = this.handlers.get(request.type)

    if (!handler) {
      logger.warn(`没有注册的处理器: ${request.type}`)
      return {
        requestId: request.id,
        approved: false,
        feedback: `未知的协议类型: ${request.type}`,
        respondedAt: Date.now(),
      }
    }

    try {
      const response = await handler(request)
      return response
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`处理协议请求失败: ${request.id}`, error)
      return {
        requestId: request.id,
        approved: false,
        feedback: `处理失败: ${errorMsg}`,
        respondedAt: Date.now(),
      }
    }
  }

  /**
   * 取消请求
   */
  cancelRequest(requestId: string): boolean {
    const request = this.pendingRequests.get(requestId)
    if (!request) return false

    request.state = ProtocolState.CANCELLED
    this.pendingRequests.delete(requestId)
    this.emit('cancelled', request)
    logger.info(`取消请求: ${requestId}`)

    return true
  }

  /**
   * 获取待处理请求
   */
  getPendingRequests(type?: ProtocolType): ProtocolRequest[] {
    const requests = Array.from(this.pendingRequests.values())
    if (type) {
      return requests.filter(r => r.type === type)
    }
    return requests
  }

  /**
   * 获取请求状态
   */
  getRequestState(requestId: string): ProtocolState | null {
    const request = this.pendingRequests.get(requestId)
    return request?.state || null
  }

  // === 便捷方法 ===

  /**
   * 发送关闭请求
   */
  async sendShutdownRequest(
    from: string,
    to: string,
    reason: string
  ): Promise<ProtocolResponse> {
    return this.sendRequest(
      ProtocolType.SHUTDOWN,
      from,
      to,
      { reason }
    )
  }

  /**
   * 发送计划审批请求
   */
  async sendPlanApprovalRequest(
    from: string,
    to: string,
    plan: {
      title: string
      description: string
      steps: string[]
    }
  ): Promise<ProtocolResponse> {
    return this.sendRequest(
      ProtocolType.PLAN_APPROVAL,
      from,
      to,
      plan
    )
  }

  /**
   * 发送任务分配
   */
  async sendTaskAssignment(
    from: string,
    to: string,
    task: {
      id: string
      title: string
      description: string
      priority: 'low' | 'normal' | 'high'
    }
  ): Promise<ProtocolResponse> {
    return this.sendRequest(
      ProtocolType.TASK_ASSIGNMENT,
      from,
      to,
      task
    )
  }

  // === 私有方法 ===

  private generateRequestId(): string {
    this.requestCounter++
    const timestamp = Date.now().toString(36)
    return `req-${timestamp}-${this.requestCounter.toString(36)}`
  }

  private cleanupExpiredRequests(): void {
    const now = Date.now()
    for (const [id, request] of this.pendingRequests) {
      if (now - request.createdAt > request.timeout) {
        request.state = ProtocolState.TIMEOUT
        this.pendingRequests.delete(id)
        this.emit('timeout', request)
      }
    }
  }

  /**
   * 保存协议历史
   */
  async saveHistory(): Promise<void> {
    if (!this.config.storageDir) return

    const historyFile = path.join(this.config.storageDir, 'protocol-history.jsonl')
    const history = Array.from(this.pendingRequests.values())
      .filter(r => r.state === ProtocolState.COMPLETED)
      .map(r => JSON.stringify(r))

    if (history.length > 0) {
      await fs.appendFile(historyFile, history.join('\n') + '\n', 'utf-8')
    }
  }
}

// 默认实例
let defaultProtocols: TeamProtocols | null = null

/**
 * 获取默认协议管理器
 */
export function getTeamProtocols(): TeamProtocols {
  if (!defaultProtocols) {
    defaultProtocols = new TeamProtocols()
  }
  return defaultProtocols
}

/**
 * 重置协议管理器
 */
export function resetTeamProtocols(): void {
  defaultProtocols = null
}

// === 默认处理器 ===

/**
 * 创建默认关闭处理器
 */
export function createShutdownHandler(
  onShutdown: (reason: string) => Promise<boolean>
): ProtocolHandler {
  return async (request: ProtocolRequest) => {
    const content = request.content as { reason: string }
    const approved = await onShutdown(content.reason)

    return {
      requestId: request.id,
      approved,
      feedback: approved ? '同意关闭' : '拒绝关闭',
      respondedAt: Date.now(),
    }
  }
}

/**
 * 创建默认计划审批处理器
 */
export function createPlanApprovalHandler(
  onPlanApproval: (plan: unknown) => Promise<{ approved: boolean; feedback?: string }>
): ProtocolHandler {
  return async (request: ProtocolRequest) => {
    const result = await onPlanApproval(request.content)

    return {
      requestId: request.id,
      approved: result.approved,
      feedback: result.feedback,
      respondedAt: Date.now(),
    }
  }
}
