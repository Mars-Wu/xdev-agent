// src/tools/task-tool.ts
// Task 工具定义 - s07 持久化任务系统

import type { Tool, ToolResult } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { getTaskSystem, TaskPriority, TaskStatus } from './task-system'
import { getWorkflowRuntime } from './workflow-runtime'
import { createLogger } from '../utils/logger'

const logger = createLogger('task-tool')

/**
 * 创建 Task 工具
 */
export function createTaskTool(): Tool {
  return {
    definition: {
      name: 'task',
      description:
        '管理持久化任务。创建、更新、查看任务状态，支持任务依赖（DAG）。' +
        '使用场景：' +
        '- 复杂项目分解为多个子任务' +
        '- 任务之间有依赖关系' +
        '- 需要持久化任务状态' +
        '- 多 Agent 协作时分配任务',
      parameters: {
        action: {
          type: 'string',
          description: '操作类型: create(创建), update(更新), start(开始), complete(完成), fail(失败), cancel(取消), get(详情), list(列表), delete(删除), summary(摘要)',
          enum: ['create', 'update', 'start', 'complete', 'fail', 'cancel', 'get', 'list', 'delete', 'summary'],
        },
        title: {
          type: 'string',
          description: '任务标题（create 时必需）',
        },
        description: {
          type: 'string',
          description: '任务描述（create 时可选）',
        },
        id: {
          type: 'string',
          description: '任务 ID（update/get/start/complete/fail/cancel/delete 时必需）',
        },
        status: {
          type: 'string',
          description: '任务状态（update 时使用）',
          enum: ['pending', 'blocked', 'in_progress', 'completed', 'failed', 'cancelled'],
        },
        priority: {
          type: 'string',
          description: '优先级: low, normal, high, critical',
          enum: ['low', 'normal', 'high', 'critical'],
        },
        dependencies: {
          type: 'array',
          description: '依赖的任务 ID 列表（create 时使用）',
          items: { type: 'string' },
        },
        tags: {
          type: 'array',
          description: '标签列表',
          items: { type: 'string' },
        },
        assignee: {
          type: 'string',
          description: '执行者 ID（Agent 名称）',
        },
        result: {
          type: 'string',
          description: '任务结果（complete 时使用）',
        },
        error: {
          type: 'string',
          description: '错误信息（fail 时使用）',
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
      const system = getTaskSystem()

      // 确保已初始化
      await system.initialize()

      try {
        switch (action) {
          case 'create': {
            const title = params.title as string
            if (!title) {
              return errorResult('创建任务需要提供 title 参数')
            }

            const task = system.createTask(
              title,
              (params.description as string) || '',
              {
                priority: (params.priority as TaskPriority) || 'normal',
                dependencies: (params.dependencies as string[]) || [],
                tags: (params.tags as string[]) || [],
                assignee: params.assignee as string,
                metadata: {
                  ...(params.metadata as Record<string, unknown> | undefined),
                  workflowId: params.workflowId as string | undefined,
                  stageId: params.stageId as string | undefined,
                },
              }
            )

            await syncTaskWorkflow('created', task, {
              workflowId: params.workflowId as string | undefined,
              stageId: params.stageId as string | undefined,
            })

            logger.info(`创建任务: ${task.id} - ${title}`)
            return successResult(`任务已创建: ${task.id}\n标题: ${title}\n状态: ${task.status}`)
          }

          case 'update': {
            const id = params.id as string
            const status = params.status as TaskStatus | undefined

            if (!id) {
              return errorResult('更新任务需要提供 id 参数')
            }

            const task = system.updateTaskStatus(id, status || 'pending')
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            const nextStatus = task.status
            if (nextStatus === 'in_progress') {
              await syncTaskWorkflow('started', task, {
                workflowId: params.workflowId as string | undefined,
                stageId: params.stageId as string | undefined,
              })
            } else if (nextStatus === 'completed') {
              await syncTaskWorkflow(
                'completed',
                task,
                {
                  workflowId: params.workflowId as string | undefined,
                  stageId: params.stageId as string | undefined,
                },
                task.result,
              )
            } else if (nextStatus === 'failed') {
              await syncTaskWorkflow(
                'failed',
                task,
                {
                  workflowId: params.workflowId as string | undefined,
                  stageId: params.stageId as string | undefined,
                },
                task.error,
              )
            } else if (nextStatus === 'cancelled') {
              await syncTaskWorkflow('cancelled', task, {
                workflowId: params.workflowId as string | undefined,
                stageId: params.stageId as string | undefined,
              })
            }

            return successResult(`任务已更新: ${id}\n状态: ${task.status}`)
          }

          case 'start': {
            const id = params.id as string
            if (!id) {
              return errorResult('开始任务需要提供 id 参数')
            }

            const task = system.startTask(id, params.assignee as string)
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            await syncTaskWorkflow('started', task, {
              workflowId: params.workflowId as string | undefined,
              stageId: params.stageId as string | undefined,
            })

            return successResult(`开始任务: ${task.title}\n状态: in_progress`)
          }

          case 'complete': {
            const id = params.id as string
            if (!id) {
              return errorResult('完成任务需要提供 id 参数')
            }

            const task = system.completeTask(id, params.result as string)
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            await syncTaskWorkflow('completed', task, {
              workflowId: params.workflowId as string | undefined,
              stageId: params.stageId as string | undefined,
            }, params.result as string | undefined)

            return successResult(`任务完成: ${task.title}`)
          }

          case 'fail': {
            const id = params.id as string
            if (!id) {
              return errorResult('失败任务需要提供 id 参数')
            }

            const task = system.failTask(id, (params.error as string) || '未知错误')
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            await syncTaskWorkflow('failed', task, {
              workflowId: params.workflowId as string | undefined,
              stageId: params.stageId as string | undefined,
            }, task.error)

            return successResult(`任务失败: ${task.title}\n错误: ${task.error}`)
          }

          case 'cancel': {
            const id = params.id as string
            if (!id) {
              return errorResult('取消任务需要提供 id 参数')
            }

            const task = system.cancelTask(id)
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            await syncTaskWorkflow('cancelled', task, {
              workflowId: params.workflowId as string | undefined,
              stageId: params.stageId as string | undefined,
            })

            return successResult(`任务已取消: ${task.title}`)
          }

          case 'get': {
            const id = params.id as string
            if (!id) {
              return errorResult('获取任务需要提供 id 参数')
            }

            const task = system.getTask(id)
            if (!task) {
              return errorResult(`任务不存在: ${id}`)
            }

            const lines = [
              `# 任务: ${task.id}`,
              '',
              `- 标题: ${task.title}`,
              `- 状态: ${task.status}`,
              `- 优先级: ${task.priority}`,
            ]

            if (task.description) {
              lines.push(`- 描述: ${task.description}`)
            }

            if (task.assignee) {
              lines.push(`- 执行者: ${task.assignee}`)
            }

            if (task.dependencies.length > 0) {
              lines.push(`- 依赖: ${task.dependencies.join(', ')}`)
            }

            if (task.blockedBy.length > 0) {
              lines.push(`- 阻塞: ${task.blockedBy.length} 个任务`)
            }

            if (task.tags.length > 0) {
              lines.push(`- 标签: ${task.tags.join(', ')}`)
            }

            if (task.metadata?.workflowId) {
              lines.push(`- 工作流: ${String(task.metadata.workflowId)}`)
            }
            if (task.metadata?.stageId) {
              lines.push(`- 阶段: ${String(task.metadata.stageId)}`)
            }

            if (task.result) {
              lines.push(`- 结果: ${task.result}`)
            }

            if (task.error) {
              lines.push(`- 错误: ${task.error}`)
            }

            lines.push(`- 创建: ${new Date(task.createdAt).toLocaleString()}`)
            lines.push(`- 更新: ${new Date(task.updatedAt).toLocaleString()}`)

            return successResult(lines.join('\n'))
          }

          case 'list': {
            const tasks = system.getAllTasks()
            if (tasks.length === 0) {
              return successResult('暂无任务')
            }

            const statusFilter = params.status as TaskStatus | undefined
            const filtered = statusFilter
              ? tasks.filter(t => t.status === statusFilter)
              : tasks

            const lines = [`## 任务列表 (${filtered.length}/${tasks.length})`, '']

            for (const t of filtered) {
              const statusIcon = {
                pending: '[ ]',
                blocked: '[⏸]',
                in_progress: '[→]',
                completed: '[✓]',
                failed: '[✗]',
                cancelled: '[—]',
              }[t.status]

              const priorityMark = t.priority === 'critical' ? '🔥' :
                                   t.priority === 'high' ? '⚡' : ''

              lines.push(`- ${statusIcon} ${priorityMark}**${t.title}** (${t.id})`)
            }

            return successResult(lines.join('\n'))
          }

          case 'delete': {
            const id = params.id as string
            if (!id) {
              return errorResult('删除任务需要提供 id 参数')
            }

            const deleted = system.deleteTask(id)
            if (!deleted) {
              return errorResult(`任务不存在: ${id}`)
            }

            return successResult(`任务已删除: ${id}`)
          }

          case 'summary': {
            const summary = system.getSummary()
            return successResult(summary)
          }

          default:
            return errorResult(`未知操作: ${action}`)
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`Task 操作失败: ${action}`, error)
        return errorResult(`操作失败: ${errorMsg}`)
      }
    },
  }
}

async function syncTaskWorkflow(
  state: 'created' | 'started' | 'completed' | 'failed' | 'cancelled',
  task: { id: string; title: string; metadata?: Record<string, unknown> },
  override: { workflowId?: string; stageId?: string },
  detail?: string,
): Promise<void> {
  const workflowId = override.workflowId || (task.metadata?.workflowId as string | undefined)
  const stageId = override.stageId || (task.metadata?.stageId as string | undefined)
  if (!workflowId || !stageId) return

  const runtime = getWorkflowRuntime()
  await runtime.initialize()

  if (state === 'created') {
    runtime.attachTask(workflowId, stageId, task.id)
  }
  runtime.noteTaskLifecycle(workflowId, stageId, task.id, state, detail || task.title)
}

/**
 * 创建查看可执行任务工具
 */
export function createReadyTasksTool(): Tool {
  return {
    definition: {
      name: 'ready_tasks',
      description: '查看所有可执行的任务（pending 状态且无阻塞）',
      parameters: {},
      required: [],
      dangerous: false,
      readOnly: true,
    },

    async execute(): Promise<ToolResult> {
      const system = getTaskSystem()
      const tasks = system.getExecutableTasks()

      if (tasks.length === 0) {
        return successResult('暂无可执行的任务')
      }

      const lines = ['## 可执行任务', '']

      for (const t of tasks) {
        const priorityMark = t.priority === 'critical' ? '🔥' :
                             t.priority === 'high' ? '⚡' : ''
        lines.push(`- [ ] ${priorityMark}**${t.title}** (${t.id})`)
        if (t.description) {
          lines.push(`  ${t.description.slice(0, 100)}${t.description.length > 100 ? '...' : ''}`)
        }
      }

      return successResult(lines.join('\n'))
    },
  }
}
