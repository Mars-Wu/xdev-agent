// src/tools/bash-tool.ts
// Bash 命令执行工具

import { spawn } from 'child_process'
import { createLogger } from '../utils/logger'
import { Tool, ToolContext, ToolResult, successResult, errorResult } from './tool-interface'
import { checkCommandSafety } from './command-safety'
import { isInterrupted } from '../utils/interrupt'
import { isSafeUrl, extractUrlsFromCommand } from '../utils/url-safety'

const logger = createLogger('bash-tool')

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
- 启动/停止服务（systemctl restart xxx 或 systemctl --user restart xxx）

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

    // T3: 增强安全检查（30+ 危险模式，分硬阻断 / 警告两级）
    const safety = checkCommandSafety(command)
    if (safety.level === 'block') {
      logger.warn(`命令被安全检查拒绝: ${safety.reason} | 命令: ${command.slice(0, 100)}`)
      return errorResult(`命令被拒绝：${safety.reason}`)
    }
    if (safety.level === 'warn') {
      logger.warn(`危险命令警告 [${safety.reason}]: ${command.slice(0, 100)}`)
    }

    // T7: SSRF 防护（curl/wget 命令中的 URL 安全检查）
    if (/\b(?:curl|wget)\b/.test(command)) {
      const urls = extractUrlsFromCommand(command)
      for (const url of urls) {
        const safe = await isSafeUrl(url)
        if (!safe) {
          return errorResult(
            `URL 安全检查失败：${url} 指向私有/内网地址，请求被阻断（SSRF 防护）`,
          )
        }
      }
    }

    logger.debug(`执行命令: ${command}`)

    // T10: 使用 spawn 以支持中断信号轮询
    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd,
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      })

      let stdout = ''
      let stderr = ''
      let killed = false

      // 轮询中断信号（每 500ms 检查一次）
      const interruptCheck = setInterval(() => {
        if (isInterrupted() && !killed) {
          killed = true
          proc.kill('SIGINT')
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL')
          }, 2000)
        }
      }, 500)

      // 超时处理
      const timeoutHandle = setTimeout(() => {
        if (!killed) {
          killed = true
          proc.kill('SIGKILL')
          logger.warn(`命令超时（${timeout}ms）: ${command.slice(0, 80)}`)
        }
      }, timeout)

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      proc.on('close', (code: number | null) => {
        clearInterval(interruptCheck)
        clearTimeout(timeoutHandle)

        const raw = stdout || stderr || '(无输出)'
        const output = raw.length > 50000 ? raw.slice(0, 50000) + '\n...(输出已截断)' : raw

        if (killed && isInterrupted()) {
          resolve(successResult(output + '\n[已被用户中断]', { stdout, stderr, exitCode: 130 }))
          return
        }

        if (code === 0 || code === null) {
          resolve(successResult(output, {
            stdout: stdout.length > 50000 ? '(输出过长，已截断)' : stdout,
            stderr,
            exitCode: code ?? 0,
          }))
        } else {
          resolve({
            success: false,
            output,
            error: `命令退出码 ${code}`,
            data: { stdout, stderr, exitCode: code },
          })
        }
      })

      proc.on('error', (err: Error) => {
        clearInterval(interruptCheck)
        clearTimeout(timeoutHandle)
        resolve(errorResult(`命令执行错误: ${err.message}`))
      })
    })
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
