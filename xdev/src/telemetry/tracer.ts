// src/telemetry/tracer.ts
// OpenTelemetry 追踪器

import { createLogger } from '../utils/logger'

const logger = createLogger('tracer')

/**
 * Span 类型
 */
export enum SpanKind {
  INTERNAL = 'internal',
  SERVER = 'server',
  CLIENT = 'client',
  PRODUCER = 'producer',
  CONSUMER = 'consumer',
}

/**
 * Span 状态
 */
export enum SpanStatusCode {
  UNSET = 'unset',
  OK = 'ok',
  ERROR = 'error',
}

/**
 * Span 属性
 */
export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined
}

/**
 * Span 事件
 */
export interface SpanEvent {
  name: string
  timestamp: Date
  attributes?: SpanAttributes
}

/**
 * Span 数据
 */
export interface SpanData {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startTime: Date
  endTime?: Date
  duration?: number
  status: SpanStatusCode
  statusMessage?: string
  attributes: SpanAttributes
  events: SpanEvent[]
}

/**
 * 追踪配置
 */
export interface TracerConfig {
  serviceName: string
  serviceVersion: string
  enabled: boolean
  sampleRate: number // 0-1
  exportEndpoint?: string
}

const DEFAULT_CONFIG: TracerConfig = {
  serviceName: 'xdev',
  serviceVersion: '1.0.0',
  enabled: true,
  sampleRate: 1.0,
}

/**
 * 生成追踪 ID
 */
function generateTraceId(): string {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')
}

/**
 * 生成 Span ID
 */
function generateSpanId(): string {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')
}

/**
 * Span 类
 */
export class Span {
  private data: SpanData
  private ended: boolean = false

  constructor(
    name: string,
    kind: SpanKind = SpanKind.INTERNAL,
    parentSpanId?: string,
    traceId?: string,
    attributes?: SpanAttributes
  ) {
    this.data = {
      traceId: traceId || generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId,
      name,
      kind,
      startTime: new Date(),
      status: SpanStatusCode.UNSET,
      attributes: attributes || {},
      events: [],
    }
  }

  /**
   * 设置属性
   */
  setAttribute(key: string, value: string | number | boolean): this {
    if (!this.ended) {
      this.data.attributes[key] = value
    }
    return this
  }

  /**
   * 设置多个属性
   */
  setAttributes(attributes: SpanAttributes): this {
    if (!this.ended) {
      Object.assign(this.data.attributes, attributes)
    }
    return this
  }

  /**
   * 添加事件
   */
  addEvent(name: string, attributes?: SpanAttributes): this {
    if (!this.ended) {
      this.data.events.push({
        name,
        timestamp: new Date(),
        attributes,
      })
    }
    return this
  }

  /**
   * 设置状态
   */
  setStatus(status: SpanStatusCode, message?: string): this {
    if (!this.ended) {
      this.data.status = status
      this.data.statusMessage = message
    }
    return this
  }

  /**
   * 记录错误
   */
  recordException(error: Error | string): this {
    const message = typeof error === 'string' ? error : error.message
    const stack = typeof error === 'string' ? undefined : error.stack

    this.addEvent('exception', {
      'exception.message': message,
      'exception.stacktrace': stack,
      'exception.type': typeof error === 'string' ? 'Error' : error.constructor.name,
    })

    this.setStatus(SpanStatusCode.ERROR, message)
    return this
  }

  /**
   * 结束 Span
   */
  end(): void {
    if (this.ended) return

    this.ended = true
    this.data.endTime = new Date()
    this.data.duration = this.data.endTime.getTime() - this.data.startTime.getTime()

    // 触发导出
    Tracer.getInstance().exportSpan(this.data)
  }

  /**
   * 获取数据
   */
  getData(): SpanData {
    return { ...this.data }
  }

  /**
   * 获取 Trace ID
   */
  get traceId(): string {
    return this.data.traceId
  }

  /**
   * 获取 Span ID
   */
  get spanId(): string {
    return this.data.spanId
  }
}

/**
 * 追踪器
 */
export class Tracer {
  private static instance: Tracer | null = null

  private config: TracerConfig
  private activeSpans: Map<string, Span> = new Map()
  private completedSpans: SpanData[] = []
  private maxCompletedSpans: number = 1000

  private constructor(config: Partial<TracerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 获取单例
   */
  static getInstance(config?: Partial<TracerConfig>): Tracer {
    if (!Tracer.instance) {
      Tracer.instance = new Tracer(config)
    }
    return Tracer.instance
  }

  /**
   * 重置单例
   */
  static reset(): void {
    Tracer.instance = null
  }

  /**
   * 开始 Span
   */
  startSpan(
    name: string,
    options?: {
      kind?: SpanKind
      parent?: Span
      attributes?: SpanAttributes
    }
  ): Span {
    if (!this.config.enabled) {
      // 返回一个 no-op span
      return new Span(name)
    }

    // 采样检查
    if (Math.random() > this.config.sampleRate) {
      return new Span(name)
    }

    const span = new Span(
      name,
      options?.kind,
      options?.parent?.spanId,
      options?.parent?.traceId,
      options?.attributes
    )

    // 设置服务信息
    span.setAttribute('service.name', this.config.serviceName)
    span.setAttribute('service.version', this.config.serviceVersion)

    this.activeSpans.set(span.spanId, span)
    return span
  }

  /**
   * 导出 Span
   */
  exportSpan(data: SpanData): void {
    this.activeSpans.delete(data.spanId)
    this.completedSpans.push(data)

    // 限制数量
    if (this.completedSpans.length > this.maxCompletedSpans) {
      this.completedSpans.shift()
    }

    logger.debug(
      `Span 完成: ${data.name}, ` +
      `耗时: ${data.duration}ms, ` +
      `状态: ${data.status}`
    )
  }

  /**
   * 获取活跃 Span
   */
  getActiveSpans(): SpanData[] {
    return Array.from(this.activeSpans.values()).map(s => s.getData())
  }

  /**
   * 获取已完成 Span
   */
  getCompletedSpans(limit?: number): SpanData[] {
    const spans = [...this.completedSpans].reverse()
    return limit ? spans.slice(0, limit) : spans
  }

  /**
   * 获取统计
   */
  getStats(): {
    activeCount: number
    completedCount: number
    avgDuration: number
    errorRate: number
    byOperation: Record<string, { count: number; avgDuration: number; errorCount: number }>
  } {
    const completed = this.completedSpans

    let totalDuration = 0
    let errorCount = 0
    const byOp: Record<string, { count: number; totalDuration: number; errorCount: number }> = {}

    for (const span of completed) {
      totalDuration += span.duration || 0
      if (span.status === SpanStatusCode.ERROR) {
        errorCount++
      }

      if (!byOp[span.name]) {
        byOp[span.name] = { count: 0, totalDuration: 0, errorCount: 0 }
      }
      byOp[span.name].count++
      byOp[span.name].totalDuration += span.duration || 0
      if (span.status === SpanStatusCode.ERROR) {
        byOp[span.name].errorCount++
      }
    }

    const byOperation: Record<string, { count: number; avgDuration: number; errorCount: number }> = {}
    for (const [name, stats] of Object.entries(byOp)) {
      byOperation[name] = {
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count,
        errorCount: stats.errorCount,
      }
    }

    return {
      activeCount: this.activeSpans.size,
      completedCount: completed.length,
      avgDuration: completed.length > 0 ? totalDuration / completed.length : 0,
      errorRate: completed.length > 0 ? errorCount / completed.length : 0,
      byOperation,
    }
  }

  /**
   * 导出追踪数据
   */
  export(): string {
    return JSON.stringify({
      config: this.config,
      activeSpans: this.getActiveSpans(),
      completedSpans: this.completedSpans.slice(-100), // 最近 100 条
    }, null, 2)
  }

  /**
   * 清空数据
   */
  clear(): void {
    this.activeSpans.clear()
    this.completedSpans = []
    logger.info('追踪数据已清空')
  }
}

/**
 * 便捷函数
 */
export function startSpan(
  name: string,
  options?: {
    kind?: SpanKind
    parent?: Span
    attributes?: SpanAttributes
  }
): Span {
  return Tracer.getInstance().startSpan(name, options)
}

/**
 * 追踪异步函数
 */
export async function trace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: {
    kind?: SpanKind
    parent?: Span
    attributes?: SpanAttributes
  }
): Promise<T> {
  const span = startSpan(name, options)
  try {
    const result = await fn(span)
    span.setStatus(SpanStatusCode.OK)
    return result
  } catch (error) {
    span.recordException(error as Error)
    throw error
  } finally {
    span.end()
  }
}

/**
 * 追踪同步函数
 */
export function traceSync<T>(
  name: string,
  fn: (span: Span) => T,
  options?: {
    kind?: SpanKind
    parent?: Span
    attributes?: SpanAttributes
  }
): T {
  const span = startSpan(name, options)
  try {
    const result = fn(span)
    span.setStatus(SpanStatusCode.OK)
    return result
  } catch (error) {
    span.recordException(error as Error)
    throw error
  } finally {
    span.end()
  }
}

/**
 * 获取追踪器实例
 */
export function getTracer(config?: Partial<TracerConfig>): Tracer {
  return Tracer.getInstance(config)
}

/**
 * 重置追踪器
 */
export function resetTracer(): void {
  Tracer.reset()
}
