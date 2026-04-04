// src/tools/agent-tool.ts
// Agent 工具 - 创建子 Agent 大行复杂任务

import type { Tool, ToolResult, ToolDefinition } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { spawn } from 'child_process'
import { createLogger } from '../utils/logger'
import * as path from 'path'
import * as fs from 'fs/promises'

const logger = createLogger('agent-tool')

/**
 * Agent 类型定义
 */
export type AgentType = 'general-purpose' | 'explore' | 'plan'

/**
 * Agent 工具定义
 */
export const agentToolDefinition: ToolDefinition = {
  name: 'agent',
  description: `启动子 Agent 处理需要多步骤或并行探索的复杂任务。

何时使用子 Agent（而非直接工具调用）：
- 任务需要 3 步以上的独立思考链（例：分析整个代码库后生成报告）
- 任务可以并行拆分（例：同时探索 src/ 和 tests/ 目录）
- 需要独立上下文，避免污染当前对话历史

何时直接用工具（不要用 Agent）：
- 单次文件读取/写入 → 直接用 read/write/edit
- 单次命令执行 → 直接用 bash
- 简单搜索 → 直接用 grep/glob

prompt 参数要求：
- 必须完整自洽，子 Agent 无法访问当前对话历史
- 包含足够的上下文（路径、目标、约束条件）
- 说明期望的输出格式`,
  parameters: {
    subagent_type: {
      type: 'string',
      description: 'Agent 类型',
      enum: ['general-purpose', 'explore', 'plan'],
      default: 'general-purpose',
    },
    description: {
      type: 'string',
      description: '任务描述（3-5 个词）简短描述）',
    },
    prompt: {
      type: 'string',
      description: '完整的任务提示词',
    },
    model: {
      type: 'string',
      description: '使用的模型（可选）',
      enum: ['sonnet', 'opus', 'haiku'],
    },
    work_dir: {
      type: 'string',
      description: '工作目录（可选）',
    },
    run_in_background: {
      type: 'boolean',
      description: '是否在后台运行',
      default: false,
    },
    isolation: {
      type: 'string',
      description: '隔离模式',
      enum: ['none', 'worktree'],
      default: 'none',
    },
  },
  required: ['description', 'prompt'],
  dangerous: false,
  readOnly: false,
}

/**
 * Agent 工具实现
 */
export const agentTool: Tool = {
  definition: agentToolDefinition,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const subagentType = (params.subagent_type as AgentType) || 'general-purpose'
    const description = params.description as string
    const prompt = params.prompt as string
    const model = params.model as string | undefined
    const workDir = params.work_dir as string | undefined
    const runInBackground = params.run_in_background === true
    const isolation = params.isolation as string || 'none'

    if (!description || !prompt) {
      return errorResult('缺少 description 或 prompt 参数')
    }

    try {
      // 构建 xiaozhi-worker 命令
      const args = ['create', description]

      if (model) {
        args.push('--model', model)
      }

      if (workDir) {
        args.push('--work-dir', workDir)
      }

      if (prompt) {
        // 将 prompt 写入临时文件
        const promptFile = path.join(
          process.env.HOME || '/tmp',
          `agent-prompt-${Date.now()}.txt`
        )
        await fs.writeFile(promptFile, prompt, 'utf-8')
        args.push('--prompt-file', promptFile)
      }

      // 执行命令
      const child = spawn('xiaozhi-worker', args, {
        stdio: runInBackground ? 'ignore' : 'inherit',
      })

      if (runInBackground) {
        return successResult(`Agent 已在后台启动: ${description}`)
      }

      // 等待完成
      return new Promise((resolve) => {
        let output = ''
        child.stdout?.on('data', (data) => {
          output += data.toString()
        })

        child.on('close', (code) => {
          if (code === 0) {
            resolve(successResult(`Agent 任务完成: ${description}\n\n${output}`))
          } else {
            resolve(errorResult(`Agent 任务失败 (退出码: ${code})\n\n${output}`))
          }
        })

        child.on('error', (err) => {
          logger.error('Agent 进程错误:', err)
        })
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Agent 工具执行失败:', error)
      return errorResult(`Agent 执行失败: ${errorMsg}`)
    }
  },
}

/**
 * 创建 Agent 工具
 */
export function createAgentTool(): Tool {
  return agentTool
}
