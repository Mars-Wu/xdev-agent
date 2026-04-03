// src/telemetry/cost-tracker.ts
// 成本追踪器 - 跟踪 Token 使用和成本

import { createLogger } from '../utils/logger'
import { getModelCost, calculateCost, formatCost, type ModelCost } from './model-costs'

const logger = createLogger('cost-tracker')

/**
 * 使用记录
 */
export interface UsageRecord {
  timestamp: Date
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost: number
  metadata?: Record<string, unknown>
}

/**
 * 会话成本统计
 */
export interface SessionCostStats {
  sessionId: string
  startTime: Date
  endTime?: Date
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  turnCount: number
  byModel: Record<string, {
    inputTokens: number
    outputTokens: number
    cost: number
    turnCount: number
  }>
}

/**
 * 日成本统计
 */
export interface DailyCostStats {
  date: string // YYYY-MM-DD
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  turnCount: number
  sessions: number
  byModel: Record<string, {
    inputTokens: number
    outputTokens: number
    cost: number
  }>
}

/**
 * 成本追踪器配置
 */
export interface CostTrackerConfig {
  enableTracking: boolean
  budgetLimit?: number // 预算限制（元）
  alertThresholds: number[] // 告警阈值（如 [10, 50, 100]）
  persistHistory: boolean
  historyFile?: string
}

const DEFAULT_CONFIG: CostTrackerConfig = {
  enableTracking: true,
  alertThresholds: [10, 50, 100, 500],
  persistHistory: true,
}

/**
 * 成本追踪器
 */
export class CostTracker {
  private config: CostTrackerConfig
  private currentSession: SessionCostStats | null = null
  private history: UsageRecord[] = []
  private dailyStats: Map<string, DailyCostStats> = new Map()
  private alertedThresholds: Set<number> = new Set()
  private totalCost: number = 0

  constructor(config: Partial<CostTrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 开始新会话
   */
  startSession(sessionId: string = `session-${Date.now()}`): void {
    if (this.currentSession) {
      this.endSession()
    }

    this.currentSession = {
      sessionId,
      startTime: new Date(),
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      turnCount: 0,
      byModel: {},
    }

    this.alertedThresholds.clear()
    logger.info(`开始会话: ${sessionId}`)
  }

  /**
   * 结束当前会话
   */
  endSession(): SessionCostStats | null {
    if (!this.currentSession) return null

    this.currentSession.endTime = new Date()
    const stats = { ...this.currentSession }

    logger.info(
      `会话结束: ${stats.sessionId}, ` +
      `总成本: ${formatCost(stats.totalCost)}, ` +
      `轮次: ${stats.turnCount}`
    )

    this.currentSession = null
    return stats
  }

  /**
   * 记录使用
   */
  recordUsage(params: {
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    metadata?: Record<string, unknown>
  }): UsageRecord {
    const { model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, metadata } = params

    // 计算成本
    const cost = calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)

    // 创建记录
    const record: UsageRecord = {
      timestamp: new Date(),
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      metadata,
    }

    // 添加到历史
    this.history.push(record)
    this.totalCost += cost

    // 更新会话统计
    if (this.currentSession) {
      this.currentSession.totalCost += cost
      this.currentSession.totalInputTokens += inputTokens
      this.currentSession.totalOutputTokens += outputTokens
      this.currentSession.totalCacheReadTokens += cacheReadTokens
      this.currentSession.totalCacheWriteTokens += cacheWriteTokens
      this.currentSession.turnCount++

      // 按模型统计
      if (!this.currentSession.byModel[model]) {
        this.currentSession.byModel[model] = {
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          turnCount: 0,
        }
      }
      this.currentSession.byModel[model].inputTokens += inputTokens
      this.currentSession.byModel[model].outputTokens += outputTokens
      this.currentSession.byModel[model].cost += cost
      this.currentSession.byModel[model].turnCount++
    }

    // 更新日统计
    this.updateDailyStats(record)

    // 检查告警
    this.checkAlerts()

    logger.debug(
      `记录使用: ${model}, 输入 ${inputTokens}, 输出 ${outputTokens}, ` +
      `成本 ${formatCost(cost)}`
    )

    return record
  }

  /**
   * 更新日统计
   */
  private updateDailyStats(record: UsageRecord): void {
    const date = record.timestamp.toISOString().split('T')[0]

    if (!this.dailyStats.has(date)) {
      this.dailyStats.set(date, {
        date,
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        turnCount: 0,
        sessions: 0,
        byModel: {},
      })
    }

    const stats = this.dailyStats.get(date)!
    stats.totalCost += record.cost
    stats.totalInputTokens += record.inputTokens
    stats.totalOutputTokens += record.outputTokens
    stats.turnCount++

    // 按模型统计
    if (!stats.byModel[record.model]) {
      stats.byModel[record.model] = {
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      }
    }
    stats.byModel[record.model].inputTokens += record.inputTokens
    stats.byModel[record.model].outputTokens += record.outputTokens
    stats.byModel[record.model].cost += record.cost
  }

  /**
   * 检查告警
   */
  private checkAlerts(): void {
    if (!this.config.budgetLimit) return

    const currentCost = this.getTotalCost()
    const budgetUsed = currentCost / this.config.budgetLimit

    for (const threshold of this.config.alertThresholds) {
      const thresholdCost = this.config.budgetLimit * (threshold / 100)
      if (currentCost >= thresholdCost && !this.alertedThresholds.has(threshold)) {
        this.alertedThresholds.add(threshold)
        logger.warn(
          `成本告警: 已使用预算的 ${threshold}% ` +
          `(当前: ${formatCost(currentCost)}, 预算: ${formatCost(this.config.budgetLimit)})`
        )
      }
    }

    // 检查是否超预算
    if (currentCost > this.config.budgetLimit) {
      logger.error(
        `超预算警告: 当前成本 ${formatCost(currentCost)} ` +
        `超过预算 ${formatCost(this.config.budgetLimit)}`
      )
    }
  }

  /**
   * 获取总成本
   */
  getTotalCost(): number {
    return this.totalCost
  }

  /**
   * 获取当前会话统计
   */
  getCurrentSessionStats(): SessionCostStats | null {
    return this.currentSession ? { ...this.currentSession } : null
  }

  /**
   * 获取日统计
   */
  getDailyStats(date?: string): DailyCostStats | null {
    const targetDate = date || new Date().toISOString().split('T')[0]
    const stats = this.dailyStats.get(targetDate)
    return stats ? { ...stats } : null
  }

  /**
   * 获取历史记录
   */
  getHistory(limit?: number): UsageRecord[] {
    const records = [...this.history].reverse()
    return limit ? records.slice(0, limit) : records
  }

  /**
   * 获取成本报告
   */
  getCostReport(): {
    totalCost: number
    totalTurns: number
    avgCostPerTurn: number
    byModel: Record<string, { cost: number; turns: number; avgCostPerTurn: number }>
    todayCost: number
    todayTurns: number
    budgetUsed?: number
  } {
    const today = this.getDailyStats()
    const totalTurns = this.history.length
    const avgCostPerTurn = totalTurns > 0 ? this.totalCost / totalTurns : 0

    // 按模型汇总
    const byModel: Record<string, { cost: number; turns: number; avgCostPerTurn: number }> = {}
    for (const record of this.history) {
      if (!byModel[record.model]) {
        byModel[record.model] = { cost: 0, turns: 0, avgCostPerTurn: 0 }
      }
      byModel[record.model].cost += record.cost
      byModel[record.model].turns++
    }

    // 计算平均
    for (const model of Object.keys(byModel)) {
      byModel[model].avgCostPerTurn = byModel[model].cost / byModel[model].turns
    }

    const report: any = {
      totalCost: this.totalCost,
      totalTurns,
      avgCostPerTurn,
      byModel,
      todayCost: today?.totalCost || 0,
      todayTurns: today?.turnCount || 0,
    }

    if (this.config.budgetLimit) {
      report.budgetUsed = this.totalCost / this.config.budgetLimit
    }

    return report
  }

  /**
   * 格式化成本报告
   */
  formatCostReport(): string {
    const report = this.getCostReport()
    const lines: string[] = [
      '# 成本报告',
      '',
      `**总成本**: ${formatCost(report.totalCost)}`,
      `**总轮次**: ${report.totalTurns}`,
      `**平均每轮**: ${formatCost(report.avgCostPerTurn)}`,
      '',
      `**今日成本**: ${formatCost(report.todayCost)}`,
      `**今日轮次**: ${report.todayTurns}`,
      '',
      '## 按模型统计',
      '',
    ]

    for (const [model, stats] of Object.entries(report.byModel)) {
      const modelInfo = getModelCost(model)
      lines.push(`### ${modelInfo?.name || model}`)
      lines.push(`- 成本: ${formatCost(stats.cost)}`)
      lines.push(`- 轮次: ${stats.turns}`)
      lines.push(`- 平均: ${formatCost(stats.avgCostPerTurn)}`)
      lines.push('')
    }

    if (report.budgetUsed !== undefined) {
      lines.push('## 预算')
      lines.push(`- 已使用: ${(report.budgetUsed * 100).toFixed(1)}%`)
      if (this.config.budgetLimit) {
        lines.push(`- 预算: ${formatCost(this.config.budgetLimit)}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 清空历史
   */
  clearHistory(): void {
    this.history = []
    this.dailyStats.clear()
    this.totalCost = 0
    this.alertedThresholds.clear()
    logger.info('成本历史已清空')
  }

  /**
   * 导出数据
   */
  export(): string {
    return JSON.stringify({
      history: this.history.map(r => ({
        ...r,
        timestamp: r.timestamp.toISOString(),
      })),
      dailyStats: Object.fromEntries(this.dailyStats),
      totalCost: this.totalCost,
    }, null, 2)
  }

  /**
   * 导入数据
   */
  import(data: string): void {
    try {
      const parsed = JSON.parse(data)

      this.history = parsed.history.map((r: any) => ({
        ...r,
        timestamp: new Date(r.timestamp),
      }))

      for (const [date, stats] of Object.entries(parsed.dailyStats || {})) {
        this.dailyStats.set(date, stats as DailyCostStats)
      }

      this.totalCost = parsed.totalCost || 0
      logger.info(`导入 ${this.history.length} 条成本记录`)
    } catch (error) {
      logger.error('导入成本数据失败:', error)
    }
  }
}

// 单例
let costTrackerInstance: CostTracker | null = null

export function getCostTracker(config?: Partial<CostTrackerConfig>): CostTracker {
  if (!costTrackerInstance) {
    costTrackerInstance = new CostTracker(config)
  }
  return costTrackerInstance
}

export function resetCostTracker(): void {
  costTrackerInstance = null
}
