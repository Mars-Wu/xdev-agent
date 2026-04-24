// src/core/memory-lint-scheduler.ts
// 记忆 Lint 调度器 —— 每 24h 检查一次，超过配置间隔则触发 Lint

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { configManager, getXdevHome } from '../config'
import { getMemoryLint } from '../memory/memory-lint'
import type { LLMClient } from './llm-client'
import type { MemoryManager } from '../memory/memory-manager'
import type { TopicGraph } from '../storage/topic-graph'

const logger = createLogger('lint-scheduler')

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000  // 每 24h 检查一次是否到期

let _timer: ReturnType<typeof setInterval> | null = null

/**
 * 读取上次 Lint 运行时间
 */
async function getLastRunTime(): Promise<Date | null> {
  try {
    const stateFile = path.join(getXdevHome(), 'memory', 'lint-state.json')
    const raw = await fs.readFile(stateFile, 'utf-8')
    const state = JSON.parse(raw)
    return state.lastRun ? new Date(state.lastRun) : null
  } catch {
    return null  // 文件不存在 = 从未运行
  }
}

/**
 * 是否已到期（超过 lintIntervalDays 天）
 */
async function isDue(): Promise<boolean> {
  const cfg = configManager.getConfig().memory
  if (!cfg.lintEnabled) return false

  const lastRun = await getLastRunTime()
  if (!lastRun) return true  // 从未运行，立即执行

  const intervalMs = cfg.lintIntervalDays * 24 * 60 * 60 * 1000
  return (Date.now() - lastRun.getTime()) >= intervalMs
}

/**
 * 触发一次 Lint（fire-and-forget）
 */
function triggerLint(
  llmClient: LLMClient,
  memoryManager: MemoryManager,
  topicGraph: TopicGraph,
): void {
  setImmediate(() => {
    getMemoryLint(llmClient, memoryManager, topicGraph)
      .run()
      .then(report => {
        logger.info(`[lint-scheduler] Lint 完成：${report.summary}`)
      })
      .catch(err => {
        logger.error('[lint-scheduler] Lint 异常:', err)
      })
  })
}

/**
 * 启动 Lint 调度器
 *
 * 策略：
 * - 启动时检查一次是否到期，到期则立即触发（延迟 60s，等服务完全初始化）
 * - 之后每 24h 检查一次，到期则触发
 */
export function startLintScheduler(
  llmClient: LLMClient,
  memoryManager: MemoryManager,
  topicGraph: TopicGraph,
): void {
  if (!configManager.getConfig().memory.lintEnabled) {
    logger.info('[lint-scheduler] 记忆 Lint 已禁用（memory.lintEnabled=false）')
    return
  }

  // 启动后延迟 60s 检查（避免影响服务启动速度）
  setTimeout(async () => {
    if (await isDue()) {
      logger.info('[lint-scheduler] 距上次 Lint 已超期，立即触发')
      triggerLint(llmClient, memoryManager, topicGraph)
    } else {
      logger.debug('[lint-scheduler] 未到 Lint 周期，跳过')
    }
  }, 60_000)

  // 每 24h 周期检查
  _timer = setInterval(async () => {
    if (await isDue()) {
      logger.info('[lint-scheduler] 周期到达，触发记忆 Lint')
      triggerLint(llmClient, memoryManager, topicGraph)
    }
  }, CHECK_INTERVAL_MS)

  // 进程退出时清理 timer
  process.once('exit', stopLintScheduler)

  logger.info(`[lint-scheduler] 调度器已启动（每 ${configManager.getConfig().memory.lintIntervalDays} 天执行一次）`)
}

/**
 * 停止调度器（测试/关闭时使用）
 */
export function stopLintScheduler(): void {
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
}
