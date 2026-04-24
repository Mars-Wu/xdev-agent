// src/tools/background-tool.ts
// Background Task 工具定义 - s08

import type { Tool, ToolResult } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { getBackgroundTaskManager } from './background-tasks'
import { getWorkflowRuntime } from './workflow-runtime'
import { createLogger } from '../utils/logger'

const logger = createLogger('background-tool')

/**
 * 创建后台任务工具
 */
export function createBackgroundTool(): Tool {
  return {
    definition: {
      name: 'background',
      description:
        '管理后台任务。启动、停止、查看后台任务状态。' +
        '后台任务特点：' +
        '- 非阻塞执行，不等待完成' +
        '- 自动捕获输出' +
        '- 完成后发送通知' +
        '适用场景：' +
        '- 长时间运行的命令（编译、测试等）' +
        '- 需要并行执行的任务' +
        '- 不需要立即看到结果的操作',
      parameters: {
        action: {
          type: 'string',
          description: '操作类型: start(启动), stop(停止), list(列表), get(详情), output(输出), summary(摘要)',
          enum: ['start', 'stop', 'list', 'get', 'output', 'summary'],
        },
        name: {
          type: 'string',
          description: '任务名称（start 时使用）',
        },
        command: {
          type: 'string',
          description: '要执行的命令（start 时使用）',
        },
        args: {
          type: 'array',
          description: '命令参数',
          items: { type: 'string' },
        },
        id: {
          type: 'string',
          description: '任务 ID（stop/get/output 时使用）',
        },
        force: {
          type: 'boolean',
          description: '强制停止（使用 SIGKILL）',
        },
        cwd: {
          type: 'string',
          description: '工作目录',
        },
        workflowId: {
          type: 'string',
          description: '关联的工作流 ID',
        },
        stageId: {
          type: 'string',
          description: '关联的工作流阶段 ID',
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string
      const manager = getBackgroundTaskManager()

      try {
        switch (action) {
          case 'start': {
            const name = params.name as string
            const command = params.command as string

            if (!name || !command) {
              return errorResult('启动任务需要提供 name 和 command 参数')
            }

            const args = (params.args as string[]) || []
            const workflowId = params.workflowId as string | undefined
            const stageId = params.stageId as string | undefined
            const task = manager.startTask(name, command, args, {
              cwd: params.cwd as string,
              metadata: {
                workflowId,
                stageId,
              },
              onComplete: async (result) => {
                if (!workflowId || !stageId) return
                const runtime = getWorkflowRuntime()
                await runtime.initialize()
                runtime.noteBackgroundTaskLifecycle(
                  workflowId,
                  stageId,
                  result.id,
                  result.status === 'completed' ? 'completed' : 'failed',
                  result.status === 'completed'
                    ? `exit=${result.exitCode ?? 0}`
                    : result.stderr || `exit=${result.exitCode ?? 'unknown'}`,
                )
              },
            })

            if (workflowId && stageId) {
              const runtime = getWorkflowRuntime()
              await runtime.initialize()
              runtime.attachBackgroundTask(workflowId, stageId, task.id)
              runtime.noteBackgroundTaskLifecycle(workflowId, stageId, task.id, 'started', name)
            }

            return successResult(
              `后台任务已启动\nID: ${task.id}\n名称: ${name}\nPID: ${task.pid}\n\n任务将在后台运行，完成后会发送通知`
            )
          }

          case 'stop': {
            const id = params.id as string
            if (!id) {
              return errorResult('停止任务需要提供 id 参数')
            }

            const force = params.force === true
            const task = manager.getTask(id)
            const stopped = manager.stopTask(id, force)

            if (!stopped) {
              return errorResult(`无法停止任务: ${id}（可能不存在或已结束）`)
            }

            const workflowId = params.workflowId as string | undefined || (task?.metadata?.workflowId as string | undefined)
            const stageId = params.stageId as string | undefined || (task?.metadata?.stageId as string | undefined)
            if (workflowId && stageId) {
              const runtime = getWorkflowRuntime()
              await runtime.initialize()
              runtime.noteBackgroundTaskLifecycle(workflowId, stageId, id, 'cancelled', force ? 'force stop' : 'stop')
            }

            return successResult(`任务已停止: ${id}`)
          }

          case 'list': {
            const tasks = manager.getAllTasks()
            if (tasks.length === 0) {
              return successResult('暂无后台任务')
            }

            const running = tasks.filter(t => t.status === 'running')
            const completed = tasks.filter(t => t.status !== 'running')

            const lines = ['## 后台任务列表', '']

            if (running.length > 0) {
              lines.push('### 运行中')
              for (const t of running) {
                const duration = Math.round((Date.now() - t.startedAt) / 1000)
                lines.push(`- [→] **${t.name}** (${t.id}) - ${duration}s`)
              }
              lines.push('')
            }

            if (completed.length > 0) {
              lines.push('### 已完成')
              for (const t of completed.slice(0, 10)) {
                const icon = t.status === 'completed' ? '✓' :
                             t.status === 'failed' ? '✗' : '—'
                lines.push(`- [${icon}] **${t.name}** (${t.id}) - ${t.status}`)
              }
            }

            return successResult(lines.join('\n'))
          }

          case 'get': {
            const id = params.id as string
            if (!id) {
              return errorResult('获取任务需要提供 id 参数')
            }

            const task = manager.getTask(id)
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            const lines = [
              `# 后台任务: ${task.id}`,
              '',
              `- 名称: ${task.name}`,
              `- 状态: ${task.status}`,
              `- 命令: ${task.command} ${task.args.join(' ')}`,
              `- PID: ${task.pid || 'N/A'}`,
              `- 开始: ${new Date(task.startedAt).toLocaleString()}`,
            ]

            if (task.endedAt) {
              lines.push(`- 结束: ${new Date(task.endedAt).toLocaleString()}`)
              lines.push(`- 耗时: ${Math.round((task.endedAt - task.startedAt) / 1000)}s`)
            }

            if (task.exitCode !== undefined) {
              lines.push(`- 退出码: ${task.exitCode}`)
            }

            if (task.metadata?.workflowId) {
              lines.push(`- 工作流: ${String(task.metadata.workflowId)}`)
            }
            if (task.metadata?.stageId) {
              lines.push(`- 阶段: ${String(task.metadata.stageId)}`)
            }

            return successResult(lines.join('\n'))
          }

          case 'output': {
            const id = params.id as string
            if (!id) {
              return errorResult('获取输出需要提供 id 参数')
            }

            const output = manager.getTaskOutput(id)
            if (!output) {
              return errorResult(`任务不存在: ${id}`)
            }

            const lines = [`# 任务输出: ${id}`, '']

            if (output.stdout) {
              lines.push('## 标准输出')
              lines.push('```')
              lines.push(output.stdout.slice(-5000)) // 限制输出长度
              lines.push('```')
              lines.push('')
            }

            if (output.stderr) {
              lines.push('## 标准错误')
              lines.push('```')
              lines.push(output.stderr.slice(-5000))
              lines.push('```')
            }

            return successResult(lines.join('\n'))
          }

          case 'summary': {
            return successResult(manager.getSummary())
          }

          default:
            return errorResult(`未知操作: ${action}`)
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`Background 操作失败: ${action}`, error)
        return errorResult(`操作失败: ${errorMsg}`)
      }
    },
  }
}

/**
 * 创建通知工具
 */
export function createNotificationTool(): Tool {
  return {
    definition: {
      name: 'notifications',
      description: '查看和管理通知。后台任务完成、失败等事件会产生通知。',
      parameters: {
        action: {
          type: 'string',
          description: '操作类型: list(列表), unread(未读), read(标记已读), clear(清除已读)',
          enum: ['list', 'unread', 'read', 'clear'],
        },
        id: {
          type: 'string',
          description: '通知 ID（read 时使用）',
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: true,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string
      const manager = getBackgroundTaskManager()

      switch (action) {
        case 'list': {
          const notifications = manager.getAllNotifications()
          if (notifications.length === 0) {
            return successResult('暂无通知')
          }

          const lines = ['## 通知列表', '']

          for (const n of notifications.slice(0, 20)) {
            const icon = n.type === 'task_completed' ? '✓' :
                         n.type === 'task_failed' ? '✗' :
                         n.type === 'task_started' ? '→' : '•'
            const readMark = n.read ? '' : ' **[新]**'
            const time = new Date(n.createdAt).toLocaleTimeString()

            lines.push(`- [${icon}]${readMark} ${n.title} - ${time}`)
            if (n.content) {
              lines.push(`  ${n.content.split('\n')[0]}`)
            }
          }

          return successResult(lines.join('\n'))
        }

        case 'unread': {
          const notifications = manager.getUnreadNotifications()
          if (notifications.length === 0) {
            return successResult('没有未读通知')
          }

          const lines = [`## 未读通知 (${notifications.length})`, '']

          for (const n of notifications) {
            const icon = n.type === 'task_completed' ? '✓' :
                         n.type === 'task_failed' ? '✗' : '•'

            lines.push(`- [${icon}] **${n.title}**`)
            if (n.content) {
              lines.push(`  ${n.content}`)
            }
            lines.push('')
          }

          return successResult(lines.join('\n'))
        }

        case 'read': {
          const id = params.id as string

          if (id) {
            const read = manager.markAsRead(id)
            if (!read) {
              return errorResult(`通知不存在: ${id}`)
            }
            return successResult(`已标记为已读: ${id}`)
          } else {
            manager.markAllAsRead()
            return successResult('已标记所有通知为已读')
          }
        }

        case 'clear': {
          manager.clearReadNotifications()
          return successResult('已清除所有已读通知')
        }

        default:
          return errorResult(`未知操作: ${action}`)
      }
    },
  }
}
