// src/tools/bash-tool.ts
// Bash 命令执行工具

import { exec } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { Tool, ToolContext, ToolResult, successResult, errorResult } from './tool-interface'

const logger = createLogger('bash-tool')
const execAsync = promisify(exec)

/**
 * Bash 工具定义
 */
const bashToolDefinition = {
  name: 'bash',
  description: '执行 shell 命令。支持所有标准 bash 命令。使用时需注意安全性。',
  parameters: {
    command: {
      type: 'string' as const,
      description: '要执行的 bash 命令',
    },
    timeout: {
      type: 'number' as const,
      description: '超时时间（毫秒），默认 120000',
      default: 120000,
    },
    cwd: {
      type: 'string' as const,
      description: '工作目录，默认使用上下文中的 workDir',
    },
  },
  required: ['command'],
  dangerous: false,
  readOnly: false,
  timeout: 120000,
}

/**
 * Bash 工具
 */
export const bashTool: Tool = {
  definition: bashToolDefinition,

  async execute(
    params: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<ToolResult> {
    const command = params.command as string
    const timeout = (params.timeout as number) || context?.timeout || 120000
    const cwd = (params.cwd as string) || context?.workDir

    if (!command) {
      return errorResult('缺少 command 参数')
    }

    try {
      logger.debug(`执行命令: ${command}`)

      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
        },
      })

      const output = stdout || stderr || '(无输出)'

      // 截断过长输出
      const truncatedOutput =
        output.length > 50000
          ? output.slice(0, 50000) + '\n...(输出已截断)'
          : output

      return successResult(truncatedOutput, {
        stdout: stdout.length > 50000 ? '(输出过长，已截断)' : stdout,
        stderr,
        exitCode: 0,
      })
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message?: string }
      // 即使命令失败，也返回输出（包含错误信息）
      const output = execError.stdout || execError.stderr || execError.message || 'Unknown error'

      return {
        success: false,
        output,
        error: execError.message || 'Command failed',
        data: {
          stdout: execError.stdout,
          stderr: execError.stderr,
        },
      }
    }
  },

  validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!params.command || typeof params.command !== 'string') {
      errors.push('command 参数必须是字符串')
    }

    if (params.timeout && typeof params.timeout !== 'number') {
      errors.push('timeout 参数必须是数字')
    }

    if (params.cwd && typeof params.cwd !== 'string') {
      errors.push('cwd 参数必须是字符串')
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
  },
}

/**
 * 创建 Bash 工具实例
 */
export function createBashTool(): Tool {
  return bashTool
}
