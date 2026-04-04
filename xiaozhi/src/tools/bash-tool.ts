// src/tools/bash-tool.ts
// Bash 命令执行工具

import { exec } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { Tool, ToolContext, ToolResult, successResult, errorResult } from './tool-interface'

const logger = createLogger('bash-tool')
const execAsync = promisify(exec)

// p2-cmd-safety：结构性危险模式检测（参考 originClaw bashSecurity.ts）
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\$\{[^}]*@[PQE]/, message: '${var@P} 参数转换（可能构造注入命令）' },
  { pattern: /eval\s+/, message: 'eval 执行' },
  { pattern: /curl[^|]*\|\s*(ba?sh|sh)\b/i, message: '管道执行远程脚本' },
  { pattern: /wget[^|]*\|\s*(ba?sh|sh)\b/i, message: '管道执行远程脚本' },
  { pattern: /\/dev\/tcp\//i, message: '/dev/tcp 网络反弹' },
  { pattern: /rm\s+-rf\s+\/(?:\s|$)/, message: 'rm -rf / 删除根目录' },
  { pattern: /:\(\)\s*\{.*\}\s*;/, message: 'fork bomb' },
]

function validateCommand(cmd: string): { safe: boolean; reason?: string } {
  for (const { pattern, message } of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { safe: false, reason: `检测到危险模式：${message}` }
    }
  }
  return { safe: true }
}

/**
 * Bash 工具定义
 */
const bashToolDefinition = {
  name: 'bash',
  description: `执行 shell 命令（bash）。

适用场景：
- 运行构建/测试命令（npm test、npm run build、git status）
- 查询文件系统（ls、find、wc -l、du）
- 安装依赖（npm install、pip install）
- 管道组合（cat file | grep pattern）
- 启动/停止服务（systemctl --user restart xxx）

不适用（使用专用工具替代）：
- 读取文件内容 → 使用 read 工具
- 写入/修改文件 → 使用 write / edit 工具
- 搜索文件内容 → 使用 grep 工具
- 查找文件路径 → 使用 glob 工具

注意：
- 超时 120 秒后自动终止
- 输出超过 50KB 会被截断
- 禁止：eval、curl|bash、/dev/tcp、rm -rf /`,
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

    // p2-cmd-safety：安全检查
    const safety = validateCommand(command)
    if (!safety.safe) {
      logger.warn(`命令被安全检查拒绝: ${safety.reason} | 命令: ${command.slice(0, 100)}`)
      return errorResult(`命令被拒绝：${safety.reason}`)
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
