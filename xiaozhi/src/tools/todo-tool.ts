// src/tools/todo-tool.ts
// Todo 工具定义

import type { Tool, ToolResult } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { getTodoManager, TodoStatus } from './todo-manager'
import { createLogger } from '../utils/logger'

const logger = createLogger('todo-tool')

/**
 * 创建 Todo 工具
 */
export function createTodoTool(): Tool {
  return {
    definition: {
      name: 'todo',
      description:
        '管理任务进度。创建、更新、查看任务状态。' +
        '使用规则：' +
        '- 同一时间只能有一个 in_progress 任务' +
        '- 完成任务后立即标记为 completed' +
        '- 创建任务时内容要具体明确',
      parameters: {
        action: {
          type: 'string',
          description: '操作类型: create(创建), update(更新), list(列表), get(详情), clear(清空)',
          enum: ['create', 'update', 'list', 'get', 'clear'],
        },
        content: {
          type: 'string',
          description: '任务内容（create 时必需）',
        },
        id: {
          type: 'string',
          description: '任务 ID（update/get 时必需）',
        },
        status: {
          type: 'string',
          description: '任务状态: pending(待处理), in_progress(进行中), completed(已完成)',
          enum: ['pending', 'in_progress', 'completed'],
        },
      },
      required: ['action'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string
      const manager = getTodoManager()

      try {
        switch (action) {
          case 'create': {
            const content = params.content as string
            if (!content) {
              return errorResult('创建任务需要提供 content 参数')
            }
            const metadata = params.metadata as Record<string, unknown> | undefined
            const todo = manager.createTodo(content, metadata)
            logger.info(`创建任务: ${todo.id} - ${content}`)
            return successResult(`任务已创建: ${todo.id}\n内容: ${content}\n状态: pending`)
          }

          case 'update': {
            const id = params.id as string
            const status = params.status as TodoStatus | undefined

            if (!id) {
              return errorResult('更新任务需要提供 id 参数')
            }

            if (!status) {
              return errorResult('更新任务需要提供 status 参数')
            }

            const todo = manager.updateTodo(id, status)
            if (!todo) {
              return errorResult(`任务不存在: ${id}`)
            }

            logger.info(`更新任务: ${id} -> ${status}`)
            return successResult(`任务已更新: ${id}\n状态: ${status}\n内容: ${todo.content}`)
          }

          case 'list': {
            const todos = manager.getAllTodos()
            if (todos.length === 0) {
              return successResult('暂无任务')
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

            return successResult(lines.join('\n'))
          }

          case 'get': {
            const id = params.id as string
            if (!id) {
              return errorResult('获取任务需要提供 id 参数')
            }

            const todo = manager.getTodo(id)
            if (!todo) {
              return errorResult(`任务不存在: ${id}`)
            }

            const lines = [
              `# 任务: ${todo.id}`,
              '',
              `- 内容: ${todo.content}`,
              `- 状态: ${todo.status}`,
              `- 创建: ${new Date(todo.createdAt).toLocaleString()}`,
              `- 更新: ${new Date(todo.updatedAt).toLocaleString()}`,
            ]

            if (todo.completedAt) {
              lines.push(`- 完成: ${new Date(todo.completedAt).toLocaleString()}`)
            }

            if (todo.metadata) {
              lines.push(`- 元数据: ${JSON.stringify(todo.metadata)}`)
            }

            return successResult(lines.join('\n'))
          }

          case 'clear': {
            manager.clear()
            return successResult('所有任务已清空')
          }

          default:
            return errorResult(`未知操作: ${action}`)
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`Todo 操作失败: ${action}`, error)
        return errorResult(`操作失败: ${errorMsg}`)
      }
    },
  }
}

/**
 * 创建开始任务工具（快捷工具）
 */
export function createStartTodoTool(): Tool {
  return {
    definition: {
      name: 'start_todo',
      description: '开始一个任务（设置状态为 in_progress）',
      parameters: {
        id: {
          type: 'string',
          description: '任务 ID',
        },
      },
      required: ['id'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const manager = getTodoManager()

      const todo = manager.startTodo(id)
      if (!todo) {
        return errorResult(`任务不存在: ${id}`)
      }

      return successResult(`开始任务: ${todo.content}\n状态: in_progress`)
    },
  }
}

/**
 * 创建完成任务工具（快捷工具）
 */
export function createCompleteTodoTool(): Tool {
  return {
    definition: {
      name: 'complete_todo',
      description: '完成任务（设置状态为 completed）',
      parameters: {
        id: {
          type: 'string',
          description: '任务 ID',
        },
      },
      required: ['id'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const id = params.id as string
      const manager = getTodoManager()

      const todo = manager.completeTodo(id)
      if (!todo) {
        return errorResult(`任务不存在: ${id}`)
      }

      return successResult(`任务完成: ${todo.content}`)
    },
  }
}
