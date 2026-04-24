// src/tools/schedule-tool.ts
// 定时任务工具

import type { Tool, ToolResult, ToolDefinition } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { createLogger } from '../utils/logger'
import * as cron from 'node-cron'

const logger = createLogger('schedule-tool')

// 存储所有定时任务
const scheduledJobs: Map<string, cron.ScheduledTask> = new Map()

/**
 * Schedule 工具定义
 */
export const scheduleToolDefinition: ToolDefinition = {
  name: 'schedule',
  description: `创建和管理定时任务。支持:
- 创建一次性提醒
- 创建周期性任务
- 列出所有任务
- 取消任务`,
  parameters: {
    action: {
      type: 'string',
      description: '操作类型',
      enum: ['create', 'list', 'cancel'],
    },
    cron: {
      type: 'string',
      description: 'Cron 表达式 (分 时 日 月 周， 例如 "0 9 * * *" 表示每天 9:00)',
    },
    prompt: {
      type: 'string',
      description: '任务提示词（到达时间后发送给 LLM 的消息）',
    },
    recurring: {
      type: 'boolean',
      description: '是否为周期性任务（默认 true）',
    },
    job_id: {
      type: 'string',
      description: '任务 ID（用于取消任务）',
    },
  },
  required: ['action'],
  dangerous: false,
  readOnly: false,
}

/**
 * Schedule 工具实现
 */
export const scheduleTool: Tool = {
  definition: scheduleToolDefinition,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const action = params.action as string

    switch (action) {
      case 'create': {
        const cronExpr = params.cron as string
        const promptText = params.prompt as string
        const recurring = params.recurring !== false

        if (!cronExpr || !promptText) {
          return errorResult('create 操作需要 cron 和 prompt 参数')
        }

        // 验证 cron 表达式
        if (!cron.validate(cronExpr)) {
          return errorResult(`无效的 cron 表达式: ${cronExpr}`)
        }

        // 生成任务 ID
        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

        // 创建任务
        const task = cron.schedule(cronExpr, () => {
          logger.info(`执行定时任务: ${jobId}`)
          console.log(`[SCHEDULE] ${jobId}: ${promptText}`)
        })

        scheduledJobs.set(jobId, task)

        logger.info(`创建定时任务: ${jobId} (${cronExpr})`)

        return successResult(
          `定时任务已创建\n\nID: ${jobId}\nCron: ${cronExpr}\n类型: ${recurring ? '周期性' : '一次性'}`,
          { jobId, cron: cronExpr, recurring }
        )
      }

      case 'list': {
        if (scheduledJobs.size === 0) {
          return successResult('暂无定时任务')
        }

        const lines = ['定时任务列表:', '']
        scheduledJobs.forEach((task, id) => {
          lines.push(`- ${id}`)
        })

        return successResult(lines.join('\n'), {
          count: scheduledJobs.size,
          jobs: Array.from(scheduledJobs.keys()),
        })
      }

      case 'cancel': {
        const jobId = params.job_id as string

        if (!jobId) {
          return errorResult('cancel 操作需要 job_id 参数')
        }

        const task = scheduledJobs.get(jobId)
        if (!task) {
          return errorResult(`任务不存在: ${jobId}`)
        }

        task.stop()
        scheduledJobs.delete(jobId)

        logger.info(`取消定时任务: ${jobId}`)

        return successResult(`定时任务已取消: ${jobId}`)
      }

      default:
        return errorResult(`未知操作: ${action}`)
    }
  },
}

/**
 * 创建 Schedule 工具
 */
export function createScheduleTool(): Tool {
  return scheduleTool
}

/**
 * 停止所有定时任务
 */
export function stopAllScheduledJobs(): void {
  scheduledJobs.forEach((task) => task.stop())
  scheduledJobs.clear()
  logger.info('已停止所有定时任务')
}
