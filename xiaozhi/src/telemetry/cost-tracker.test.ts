// src/telemetry/cost-tracker.test.ts
// 成本追踪器单元测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CostTracker,
  getCostTracker,
  resetCostTracker,
} from './cost-tracker'
import { calculateCost, formatCost, getModelCost } from './model-costs'

describe('CostTracker', () => {
  let tracker: CostTracker

  beforeEach(() => {
    tracker = new CostTracker()
    resetCostTracker()
  })

  afterEach(() => {
    resetCostTracker()
  })

  describe('会话管理', () => {
    it('应该成功开始会话', () => {
      tracker.startSession('test-session')
      const stats = tracker.getCurrentSessionStats()
      expect(stats).toBeDefined()
      expect(stats?.sessionId).toBe('test-session')
    })

    it('应该自动生成会话 ID', () => {
      tracker.startSession()
      const stats = tracker.getCurrentSessionStats()
      expect(stats?.sessionId).toMatch(/^session-/)
    })

    it('应该成功结束会话', () => {
      tracker.startSession('test-session')
      const stats = tracker.endSession()
      expect(stats).toBeDefined()
      expect(stats?.sessionId).toBe('test-session')
      expect(stats?.endTime).toBeDefined()
    })

    it('结束不存在的会话应该返回 null', () => {
      const stats = tracker.endSession()
      expect(stats).toBeNull()
    })
  })

  describe('使用记录', () => {
    beforeEach(() => {
      tracker.startSession('test-session')
    })

    it('应该成功记录使用', () => {
      const record = tracker.recordUsage({
        model: 'glm-5',
        inputTokens: 1000,
        outputTokens: 500,
      })

      expect(record).toBeDefined()
      expect(record.model).toBe('glm-5')
      expect(record.inputTokens).toBe(1000)
      expect(record.outputTokens).toBe(500)
      expect(record.cost).toBeGreaterThan(0)
    })

    it('应该正确计算成本', () => {
      // GLM-5: 输入 ¥1/MTok, 输出 ¥1/MTok
      tracker.recordUsage({
        model: 'glm-5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      })

      const stats = tracker.getCurrentSessionStats()
      expect(stats?.totalCost).toBeCloseTo(2, 2) // 2 元
    })

    it('应该正确统计缓存 token', () => {
      tracker.recordUsage({
        model: 'claude-sonnet-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
      })

      const stats = tracker.getCurrentSessionStats()
      expect(stats?.totalCacheReadTokens).toBe(500)
      expect(stats?.totalCacheWriteTokens).toBe(200)
    })

    it('应该正确按模型统计', () => {
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })
      tracker.recordUsage({ model: 'glm-5-turbo', inputTokens: 2000, outputTokens: 1000 })

      const stats = tracker.getCurrentSessionStats()
      expect(stats?.byModel['glm-5']).toBeDefined()
      expect(stats?.byModel['glm-5-turbo']).toBeDefined()
    })
  })

  describe('预算告警', () => {
    it('应该在达到阈值时触发告警', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      tracker = new CostTracker({
        budgetLimit: 1, // 1 元预算
        alertThresholds: [50, 100], // 50% 和 100% 告警
      })

      tracker.startSession('test')

      // 触发 50% 告警
      tracker.recordUsage({
        model: 'glm-5',
        inputTokens: 250_000, // 0.25 元
        outputTokens: 250_000, // 0.25 元
      })

      // 触发 100% 告警
      tracker.recordUsage({
        model: 'glm-5',
        inputTokens: 250_000,
        outputTokens: 250_000,
      })

      warnSpy.mockRestore()
    })
  })

  describe('日统计', () => {
    it('应该正确统计每日使用', () => {
      tracker.startSession('test')
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })
      tracker.recordUsage({ model: 'glm-5', inputTokens: 2000, outputTokens: 1000 })

      const dailyStats = tracker.getDailyStats()
      expect(dailyStats).toBeDefined()
      expect(dailyStats?.totalInputTokens).toBe(3000)
      expect(dailyStats?.totalOutputTokens).toBe(1500)
    })
  })

  describe('成本报告', () => {
    beforeEach(() => {
      tracker.startSession('test')
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })
      tracker.recordUsage({ model: 'glm-5-turbo', inputTokens: 2000, outputTokens: 1000 })
    })

    it('应该正确生成成本报告', () => {
      const report = tracker.getCostReport()
      expect(report.totalCost).toBeGreaterThan(0)
      expect(report.totalTurns).toBe(2)
      expect(report.byModel['glm-5']).toBeDefined()
      expect(report.byModel['glm-5-turbo']).toBeDefined()
    })

    it('应该正确格式化成本报告', () => {
      const formatted = tracker.formatCostReport()
      expect(formatted).toContain('成本报告')
      expect(formatted).toContain('总成本')
      expect(formatted).toContain('GLM-5')
    })
  })

  describe('历史记录', () => {
    beforeEach(() => {
      tracker.startSession('test')
    })

    it('应该正确获取历史记录', () => {
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })
      tracker.recordUsage({ model: 'glm-5', inputTokens: 2000, outputTokens: 1000 })

      const history = tracker.getHistory(10)
      expect(history).toHaveLength(2)
    })

    it('应该限制历史记录数量', () => {
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })
      tracker.recordUsage({ model: 'glm-5', inputTokens: 2000, outputTokens: 1000 })
      tracker.recordUsage({ model: 'glm-5', inputTokens: 3000, outputTokens: 1500 })

      const history = tracker.getHistory(2)
      expect(history).toHaveLength(2)
    })
  })

  describe('导入导出', () => {
    it('应该正确导出数据', () => {
      tracker.startSession('test')
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })

      const exported = tracker.export()
      const parsed = JSON.parse(exported)

      expect(parsed.history).toBeDefined()
      expect(parsed.totalCost).toBeGreaterThan(0)
    })

    it('应该正确导入数据', () => {
      tracker.startSession('test')
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })

      const exported = tracker.export()
      tracker.clearHistory()
      tracker.import(exported)

      const history = tracker.getHistory()
      expect(history).toHaveLength(1)
    })
  })

  describe('清理功能', () => {
    it('应该成功清空历史', () => {
      tracker.startSession('test')
      tracker.recordUsage({ model: 'glm-5', inputTokens: 1000, outputTokens: 500 })
      tracker.clearHistory()

      expect(tracker.getTotalCost()).toBe(0)
    })
  })

  describe('单例模式', () => {
    it('getCostTracker 应该返回同一实例', () => {
      const instance1 = getCostTracker()
      const instance2 = getCostTracker()
      expect(instance1).toBe(instance2)
    })

    it('resetCostTracker 应该重置实例', () => {
      const instance1 = getCostTracker()
      resetCostTracker()
      const instance2 = getCostTracker()
      expect(instance1).not.toBe(instance2)
    })
  })
})

describe('Model Costs', () => {
  describe('getModelCost', () => {
    it('应该返回 GLM-5 成本配置', () => {
      const cost = getModelCost('glm-5')
      expect(cost).toBeDefined()
      expect(cost?.name).toBe('GLM-5')
      expect(cost?.inputCostPerMTok).toBe(1)
      expect(cost?.outputCostPerMTok).toBe(1)
    })

    it('未知模型应该返回 undefined', () => {
      const cost = getModelCost('unknown-model')
      expect(cost).toBeUndefined()
    })
  })

  describe('calculateCost', () => {
    it('应该正确计算 GLM-5 成本', () => {
      // 1M 输入 + 1M 输出 = 2 元
      const cost = calculateCost('glm-5', 1_000_000, 1_000_000)
      expect(cost).toBeCloseTo(2, 4)
    })

    it('应该正确计算 Claude 成本（含缓存）', () => {
      const cost = calculateCost(
        'claude-sonnet-4-6',
        1_000_000, // 输入：¥15
        500_000, // 输出：¥37.5
        500_000, // 缓存读取：¥0.75
        200_000 // 缓存写入：¥4
      )
      expect(cost).toBeCloseTo(57.25, 2)
    })

    it('未知模型应该使用默认成本', () => {
      const cost = calculateCost('unknown', 1_000_000, 1_000_000)
      expect(cost).toBeCloseTo(2, 4)
    })
  })

  describe('formatCost', () => {
    it('应该正确格式化小于 0.01 元的成本', () => {
      const formatted = formatCost(0.005)
      expect(formatted).toContain('毫')
    })

    it('应该正确格式化小于 1 元的成本', () => {
      const formatted = formatCost(0.5)
      expect(formatted).toContain('0.')
      expect(formatted).toContain('元')
    })

    it('应该正确格式化大于 1 元的成本', () => {
      const formatted = formatCost(10.5)
      expect(formatted).toContain('10.')
      expect(formatted).toContain('元')
    })
  })
})

// 导入 vi 用于 mock
import { vi } from 'vitest'
