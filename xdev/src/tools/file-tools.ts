// src/tools/file-tools.ts
// 文件操作工具：读取、写入、编辑

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { Tool, ToolContext, ToolResult, successResult, errorResult } from './tool-interface'
import { fuzzyFindAndReplace } from './fuzzy-match'

const logger = createLogger('file-tools')

// ==================== 读取工具 ====================

const readToolDefinition = {
  name: 'read',
  description: '读取文件内容（纯文本）。大文件可用 offset+limit 分页读取。\n优先于 bash cat 命令使用本工具。',
  parameters: {
    file_path: {
      type: 'string' as const,
      description: '要读取的文件路径（绝对路径）',
    },
    offset: {
      type: 'number' as const,
      description: '起始行号（可选，用于大文件分页读取）',
    },
    limit: {
      type: 'number' as const,
      description: '读取行数限制（可选，默认 2000 行）',
    },
  },
  required: ['file_path'],
  dangerous: false,
  readOnly: true,
  timeout: 30000,
}

export const readTool: Tool = {
  definition: readToolDefinition,

  async execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string
    const offset = (params.offset as number) || 0
    const limit = (params.limit as number) || 2000

    if (!filePath) {
      return errorResult('缺少 file_path 参数')
    }

    // 解析路径
    const resolvedPath = path.resolve(filePath)

    try {
      // 检查文件是否存在
      const stats = await fs.stat(resolvedPath)

      if (stats.isDirectory()) {
        return errorResult(`路径是目录，不是文件: ${resolvedPath}`)
      }

      // 读取文件
      const content = await fs.readFile(resolvedPath, 'utf-8')
      const lines = content.split('\n')

      // 分页处理
      const startLine = Math.max(0, offset)
      const endLine = Math.min(lines.length, startLine + limit)
      const selectedLines = lines.slice(startLine, endLine)

      // 添加行号
      const numberedContent = selectedLines
        .map((line, i) => `${startLine + i + 1}\t${line}`)
        .join('\n')

      return successResult(numberedContent, {
        path: resolvedPath,
        totalLines: lines.length,
        readLines: selectedLines.length,
        startLine: startLine + 1,
        endLine,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`读取文件失败: ${resolvedPath} - ${message}`)
      return errorResult(`读取文件失败: ${message}`)
    }
  },

  validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!params.file_path || typeof params.file_path !== 'string') {
      errors.push('file_path 参数必须是字符串')
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
  },
}

// ==================== 写入工具 ====================

const writeToolDefinition = {
  name: 'write',
  description: '创建新文件或完全覆盖现有文件。\n只用于全量写入；部分修改请用 edit 工具。',
  parameters: {
    file_path: {
      type: 'string' as const,
      description: '要写入的文件路径（绝对路径）',
    },
    content: {
      type: 'string' as const,
      description: '要写入的内容',
    },
  },
  required: ['file_path', 'content'],
  dangerous: true,
  readOnly: false,
  timeout: 30000,
}

export const writeTool: Tool = {
  definition: writeToolDefinition,

  async execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string
    const content = params.content as string

    if (!filePath) {
      return errorResult('缺少 file_path 参数')
    }
    if (content === undefined || content === null) {
      return errorResult('缺少 content 参数')
    }

    const resolvedPath = path.resolve(filePath)

    try {
      // 确保目录存在
      const dir = path.dirname(resolvedPath)
      await fs.mkdir(dir, { recursive: true })

      // 写入文件
      await fs.writeFile(resolvedPath, content, 'utf-8')

      logger.info(`文件已写入: ${resolvedPath}`)
      return successResult(`文件已写入: ${resolvedPath}`, {
        path: resolvedPath,
        size: content.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`写入文件失败: ${resolvedPath} - ${message}`)
      return errorResult(`写入文件失败: ${message}`)
    }
  },

  validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!params.file_path || typeof params.file_path !== 'string') {
      errors.push('file_path 参数必须是字符串')
    }
    if (params.content === undefined || params.content === null) {
      errors.push('content 参数不能为空')
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
  },
}

// ==================== 编辑工具 ====================

const editToolDefinition = {
  name: 'edit',
  description: `精确替换文件中的一段内容。

规则：
- old_string 必须与文件中某一处内容完全一致（含空格/缩进）
- old_string 在文件中必须唯一，若有多处相同请提供更多上下文
- 与 write 的区别：edit 做局部修改，write 完全覆盖文件

示例用途：
- 修改函数实现、更新配置值、重命名变量`,
  parameters: {
    file_path: {
      type: 'string' as const,
      description: '要编辑的文件路径（绝对路径）',
    },
    old_string: {
      type: 'string' as const,
      description: '要替换的内容（必须精确匹配）',
    },
    new_string: {
      type: 'string' as const,
      description: '替换后的新内容',
    },
    replace_all: {
      type: 'boolean' as const,
      description: '是否替换所有匹配项（默认 false）',
    },
  },
  required: ['file_path', 'old_string', 'new_string'],
  dangerous: true,
  readOnly: false,
  timeout: 30000,
}

export const editTool: Tool = {
  definition: editToolDefinition,

  async execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string
    const oldString = params.old_string as string
    const newString = params.new_string as string
    const replaceAll = params.replace_all === true

    if (!filePath) {
      return errorResult('缺少 file_path 参数')
    }
    if (oldString === undefined) {
      return errorResult('缺少 old_string 参数')
    }
    if (newString === undefined) {
      return errorResult('缺少 new_string 参数')
    }

    const resolvedPath = path.resolve(filePath)

    try {
      // 读取文件
      const content = await fs.readFile(resolvedPath, 'utf-8')

      if (replaceAll) {
        // replace_all 模式：仍使用精确匹配
        if (!content.includes(oldString)) {
          return errorResult(`未找到要替换的内容: ${oldString.slice(0, 50)}...`)
        }
        const newContent = content.split(oldString).join(newString)
        const replacementCount = content.split(oldString).length - 1
        await fs.writeFile(resolvedPath, newContent, 'utf-8')
        logger.info(`文件已编辑: ${resolvedPath} (全量替换 ${replacementCount} 处)`)
        return successResult(`文件已编辑: ${resolvedPath} (${replacementCount} 处替换)`, {
          path: resolvedPath,
          replacements: replacementCount,
        })
      }

      // T8: 单处替换使用8策略模糊匹配链
      const fuzzyResult = fuzzyFindAndReplace(content, oldString, newString)
      if (!fuzzyResult) {
        return errorResult(
          `未找到要替换的内容（已尝试8种匹配策略）: ${oldString.slice(0, 100)}...`,
        )
      }

      // 多处匹配（策略1精确匹配时返回 null，此处不应出现 count > 1）
      await fs.writeFile(resolvedPath, fuzzyResult.result, 'utf-8')

      const strategyNote = fuzzyResult.strategy !== 'exact'
        ? ` [使用模糊匹配策略: ${fuzzyResult.strategy}]`
        : ''
      logger.info(`文件已编辑: ${resolvedPath}${strategyNote}`)
      return successResult(`文件已编辑: ${resolvedPath}${strategyNote}`, {
        path: resolvedPath,
        replacements: 1,
        strategy: fuzzyResult.strategy,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`编辑文件失败: ${resolvedPath} - ${message}`)
      return errorResult(`编辑文件失败: ${message}`)
    }
  },

  validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = []

    if (!params.file_path || typeof params.file_path !== 'string') {
      errors.push('file_path 参数必须是字符串')
    }
    if (params.old_string === undefined) {
      errors.push('old_string 参数不能为空')
    }
    if (params.new_string === undefined) {
      errors.push('new_string 参数不能为空')
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
  },
}

// ==================== 列出目录工具 ====================

const listToolDefinition = {
  name: 'list',
  description: '列出目录内容。返回指定目录下的文件和子目录。',
  parameters: {
    path: {
      type: 'string' as const,
      description: '要列出的目录路径（默认为当前工作目录）',
    },
    pattern: {
      type: 'string' as const,
      description: 'glob 模式过滤（可选）',
    },
  },
  required: [],
  dangerous: false,
  readOnly: true,
  timeout: 10000,
}

export const listTool: Tool = {
  definition: listToolDefinition,

  async execute(params: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const dirPath = (params.path as string) || context?.workDir || process.cwd()
    const resolvedPath = path.resolve(dirPath)

    try {
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true })
      const items = entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))

      // 排序：目录优先，然后按名称
      items.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })

      const output = items.map((item) => `${item.type === 'directory' ? 'd' : '-'} ${item.name}`).join('\n')

      return successResult(output || '(空目录)', {
        path: resolvedPath,
        count: items.length,
        items,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(`列出目录失败: ${message}`)
    }
  },
}

/**
 * 创建所有文件工具
 */
export function createFileTools(): Tool[] {
  return [readTool, writeTool, editTool, listTool]
}
