// src/tools/agent-tool.ts
// Agent 工具 - 使用 InProcessAgent 在进程内隔离执行子任务
//
// 子 Agent 隔离原则（来自 learn-claude-code s04）：
//   - 干净的独立 history，不继承父 Agent 上下文
//   - tool 白名单可按类型限制
//   - 父 Agent 只接收最终文本，不感知工具调用过程

import type { Tool, ToolResult, ToolDefinition } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { createLogger } from '../utils/logger'
import { InProcessAgent, type AgentType } from '../agent/in-process-agent'
import { configManager } from '../config'

const logger = createLogger('agent-tool')

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
      description: 'Agent 类型：general-purpose（通用）/ explore（探索研究）/ plan（规划设计）',
      enum: ['general-purpose', 'explore', 'plan'],
      default: 'general-purpose',
    },
    description: {
      type: 'string',
      description: '任务简短描述（3-5 个词）',
    },
    prompt: {
      type: 'string',
      description: '完整的任务提示词（必须自含上下文，子 Agent 看不到当前对话历史）',
    },
    model: {
      type: 'string',
      description: '使用的模型（可选，默认使用配置中的 defaultModel）',
    },
    run_in_background: {
      type: 'boolean',
      description: '是否在后台异步运行（不等待结果，立即返回）',
      default: false,
    },
  },
  required: ['description', 'prompt'],
  dangerous: false,
  readOnly: false,
}

let agentCounter = 0

export const agentTool: Tool = {
  definition: agentToolDefinition,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const subagentType = (params.subagent_type as AgentType) || 'general-purpose'
    const description = params.description as string
    const prompt = params.prompt as string
    const model = (params.model as string | undefined) || configManager.getConfig().model.defaultModel
    const runInBackground = params.run_in_background === true

    if (!description || !prompt) {
      return errorResult('缺少 description 或 prompt 参数')
    }

    const agentId = `sub-agent-${++agentCounter}-${Date.now()}`
    const agent = new InProcessAgent({
      id: agentId,
      name: description,
      type: subagentType,
      model,
    })

    logger.info(`[agent-tool] 启动子 Agent: ${agentId} (${subagentType}) - ${description}`)

    if (runInBackground) {
      agent.execute(prompt)
        .then(() => { agent.cleanup() })
        .catch(err => logger.warn(`[agent-tool] 后台子 Agent 失败: ${err}`))
      return successResult(`子 Agent 已在后台启动: ${description}`)
    }

    try {
      const result = await agent.execute(prompt)
      agent.cleanup()
      return successResult(result)
    } catch (error) {
      agent.cleanup()
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('[agent-tool] 子 Agent 执行失败:', error)
      return errorResult(`子 Agent 执行失败: ${msg}`)
    }
  },
}

export function createAgentTool(): Tool {
  return agentTool
}
