// src/tools/glob-tool.ts
// 文件模式匹配工具
import { glob } from 'glob'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { Tool, ToolResult, ToolParameterSchema } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { pathToFileURL } from 'url'
import { statSync } from 'fs'

const logger = createLogger('glob-tool')

/**
 * Glob 工具定义
 */
const globToolDefinition = {
  name: 'glob',
  description: `按名称模式查找文件路径（不搜索内容）。

常用模式示例：
  **/*.ts          所有 TypeScript 文件
  src/**/*.test.ts 所有测试文件
  *.{json,yaml}    当前目录的 json/yaml
  **/index.ts      所有入口文件

与 grep 的区别：glob 按文件名匹配，grep 按内容匹配。`,
  parameters: {
    pattern: {
      type: 'string' as const,
      description: 'Glob 模式（如 **/*.ts, src/**/*.js)',
    },
    path: {
      type: 'string' as const,
      description: '搜索目录（可选，默认当前目录）',
    },
    ignore: {
      type: 'array' as const,
      description: '忽略的模式列表',
      items: { type: 'string' as const },
    },
    nodir: {
      type: 'boolean' as const,
      description: '是否排除目录（默认 true)',
      default: true,
    },
    absolute: {
      type: 'boolean' as const,
      description: '是否返回绝对路径',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['pattern'],
  dangerous: false,
  readOnly: true,
}

/**
 * Glob 工具实现
 */
export const globTool: Tool = {
  definition: globToolDefinition,

  async execute(
    params: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<ToolResult> {
    const pattern = params.pattern as string
    const searchPath = (params.path as string) || process.cwd()
    const ignore = params.ignore as string[] | undefined
    const nodir = params.nodir !== false // 默认 true
    const absolute = params.absolute === true

    if (!pattern) {
      return errorResult('缺少 pattern 参数')
    }

    try {
      const options = {
        cwd: searchPath,
        ignore: ignore || ['**/node_modules/**', '**/.git/**'],
        nodir,
        absolute,
        dot: false,
      }

      const matches = await glob(pattern, options)

      // 限制结果数量
      const maxResults = 1000
      const results = matches.slice(0, maxResults)

      let output = `找到 ${matches.length} 个匹配文件`
      if (matches.length > maxResults) {
        output += `（显示前 ${maxResults} 个）`
      }
      output += '\n\n' + results.join('\n')

      logger.info(`Glob 匹配: ${pattern} -> ${matches.length} 个文件`)

      return successResult(output, {
        count: matches.length,
        files: results,
        truncated: matches.length > maxResults,
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Glob 失败: ${pattern}`, error)
      return errorResult(`文件匹配失败: ${errorMsg}`)
    }
  },
}

/**
 * 创建 Glob 工具
 */
export function createGlobTool(): Tool {
  return globTool
}
