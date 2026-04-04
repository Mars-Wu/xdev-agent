// src/tools/grep-tool.ts
// 内容搜索工具

import { createLogger } from '../utils/logger'
import type { Tool, ToolResult, ToolParameterSchema } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { spawn } from 'child_process'

const logger = createLogger('grep-tool')

/**
 * Grep 工具定义
 */
const grepToolDefinition = {
  name: 'grep',
  description: `在文件内容中搜索文本（使用 ripgrep，比 bash grep 更快）。

适用场景：
- 查找函数/变量定义：grep "function handleMessage" src/
- 查找所有调用方：grep "import.*LLMClient" --glob "*.ts"
- 搜索配置项：grep "MAX_TURNS" .

与 glob 的区别：grep 搜索文件内容，glob 匹配文件名。
与 bash 的区别：优先用本工具替代 bash grep/rg 命令。`,
  parameters: {
    pattern: {
      type: 'string' as const,
      description: '搜索模式（正则表达式）',
    },
    path: {
      type: 'string' as const,
      description: '搜索目录或文件（可选，默认当前目录）',
    },
    glob: {
      type: 'string' as const,
      description: '文件模式过滤（如 *.ts, **/*.js）',
    },
    type: {
      type: 'string' as const,
      description: '文件类型（js, ts, py, rust, go, java 等）',
    },
    'ignore-case': {
      type: 'boolean' as const,
      description: '忽略大小写',
    },
    context: {
      type: 'number' as const,
      description: '显示匹配行前后 N 行上下文',
    },
    output_mode: {
      type: 'string' as const,
      description: '输出模式: content（显示内容）, files_with_matches（仅文件名）, count（计数）',
      enum: ['content', 'files_with_matches', 'count'],
    },
  } as Record<string, ToolParameterSchema>,
  required: ['pattern'],
  dangerous: false,
  readOnly: true,
}

/**
 * Grep 工具实现
 */
export const grepTool: Tool = {
  definition: grepToolDefinition,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = params.pattern as string
    const searchPath = (params.path as string) || '.'
    const glob = params.glob as string | undefined
    const fileType = params.type as string | undefined
    const ignoreCase = params['ignore-case'] === true
    const context = params.context as number | undefined
    const outputMode = (params.output_mode as string) || 'content'

    if (!pattern) {
      return errorResult('缺少 pattern 参数')
    }

    try {
      // 构建 rg 命令参数
      const args: string[] = ['--json']

      if (ignoreCase) args.push('-i')
      if (glob) args.push('--glob', glob)
      if (fileType) args.push('--type', fileType)
      if (context) args.push('-C', String(context))

      switch (outputMode) {
        case 'files_with_matches':
          args.push('--files-with-matches')
          break
        case 'count':
          args.push('--count')
          break
        default:
          args.push('--line-number')
      }

      args.push(pattern, searchPath)

      const result = await runCommand('rg', args)

      if (result.code !== 0 && !result.stdout) {
        return successResult('未找到匹配项', { count: 0, matches: [] })
      }

      // 解析输出
      if (outputMode === 'files_with_matches') {
        const files = result.stdout.trim().split('\n').filter(Boolean)
        return successResult(
          `找到 ${files.length} 个文件\n\n` + files.join('\n'),
          { count: files.length, files }
        )
      }

      if (outputMode === 'count') {
        return successResult(result.stdout, { raw: result.stdout })
      }

      // 解析 JSON 格式输出
      const lines = result.stdout.trim().split('\n').filter(Boolean)
      const matches: Array<{ file: string; line: number; content: string }> = []
      let output = ''

      for (const line of lines) {
        try {
          const data = JSON.parse(line)
          if (data.type === 'match') {
            for (const match of data.data.submatches || []) {
              const filePath = data.data.path.text
              const lineNum = data.data.line_number
              const content = data.data.lines.text.trim()
              matches.push({ file: filePath, line: lineNum, content })
              output += `${filePath}:${lineNum}: ${content}\n`
            }
          }
        } catch {
          // 非 JSON 行，直接添加
          output += line + '\n'
        }
      }

      logger.info(`Grep 搜索: ${pattern} -> ${matches.length} 个匹配`)

      return successResult(output, { count: matches.length, matches })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Grep 失败: ${pattern}`, error)
      return errorResult(`搜索失败: ${errorMsg}`)
    }
  },
}

/**
 * 运行命令并返回结果
 */
function runCommand(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({ code: code || 0, stdout, stderr })
    })

    proc.on('error', () => {
      resolve({ code: 1, stdout: '', stderr: 'ripgrep (rg) 未安装' })
    })
  })
}

/**
 * 创建 Grep 工具
 */
export function createGrepTool(): Tool {
  return grepTool
}
