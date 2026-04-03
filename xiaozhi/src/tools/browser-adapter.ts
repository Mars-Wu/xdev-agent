// src/tools/browser-adapter.ts
// 浏览器工具适配器

import type { Tool, ToolResult, ToolParameterSchema } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { createLogger } from '../utils/logger'
import { BrowserTool } from '../browser'
import type { BrowserAction } from '../browser/tool'

const logger = createLogger('browser-adapter')

/**
 * 浏览器工具定义
 */
const browserToolDefinition = {
  name: 'browser',
  description: `浏览器自动化工具，支持:
- visit: 访问页面并获取结构化数据
- action: 执行页面操作（点击、填写表单等）
- login: 执行登录流程`,
  parameters: {
    operation: {
      type: 'string' as const,
      description: '操作类型: visit, action, login',
      enum: ['visit', 'action', 'login'],
    },
    url: {
      type: 'string' as const,
      description: '目标 URL',
    },
    actions: {
      type: 'array' as const,
      description: '操作列表（用于 action/login）',
      items: {
        type: 'object' as const,
        properties: {
          type: { type: 'string' as const, description: '操作类型: click, fill, select, wait, press', enum: ['click', 'fill', 'select', 'wait', 'press'] },
          selector: { type: 'string' as const, description: 'CSS 选择器' },
          value: { type: 'string' as const, description: '输入值' },
        },
      },
    },
    screenshot: {
      type: 'boolean' as const,
      description: '是否截图',
      default: false,
    },
    fullPage: {
      type: 'boolean' as const,
      description: '是否全页截图',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['operation'],
  dangerous: false,
  readOnly: false,
}

// 浏览器工具实例缓存
let browserToolInstance: BrowserTool | null = null

/**
 * 获取浏览器工具实例
 */
async function getBrowserTool(): Promise<BrowserTool> {
  if (!browserToolInstance) {
    browserToolInstance = new BrowserTool({ headless: true })
  }
  return browserToolInstance
}

/**
 * 浏览器工具适配器
 */
export const browserAdapterTool: Tool = {
  definition: browserToolDefinition,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const operation = params.operation as string
    const url = params.url as string
    const actions = params.actions as Array<{
      type: string
      selector?: string
      value?: string
    }> | undefined
    const screenshot = params.screenshot === true
    const fullPage = params.fullPage === true

    try {
      const browser = await getBrowserTool()

      switch (operation) {
        case 'visit': {
          if (!url) {
            return errorResult('visit 操作需要 url 参数')
          }
          const result = await browser.visit(url, { screenshot, fullPage })
          if (result.success) {
            const output = formatPageData(result)
            return successResult(output, result.data)
          }
          return errorResult(result.error || '访问页面失败')
        }

        case 'action': {
          if (!url || !actions) {
            return errorResult('action 操作需要 url 和 actions 参数')
          }
          const result = await browser.action(url, actions as BrowserAction[], { screenshot })
          if (result.success) {
            return successResult('操作执行成功', result.data)
          }
          return errorResult(result.error || '操作执行失败')
        }

        case 'login': {
          if (!url || !actions) {
            return errorResult('login 操作需要 url 和 actions 参数')
          }
          const result = await browser.login(url, actions as BrowserAction[], { screenshot })
          if (result.success) {
            return successResult('登录成功', { ...result.data, sessionName: result.sessionName })
          }
          return errorResult(result.error || '登录失败')
        }

        default:
          return errorResult(`未知操作: ${operation}`)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`浏览器操作失败: ${operation}`, error)
      return errorResult(`操作失败: ${errorMsg}`)
    }
  },
}

/**
 * 格式化页面数据
 */
function formatPageData(result: { success: boolean; data?: Record<string, unknown> }): string {
  const lines: string[] = []
  const data = result.data

  if (!data) return '页面数据为空'

  if (data.title) {
    lines.push(`标题: ${data.title}`)
  }

  if (data.url) {
    lines.push(`URL: ${data.url}`)
  }

  if (data.elements) {
    const elements = data.elements as { headings?: unknown[]; buttons?: string[]; inputs?: unknown[] }
    if (elements.headings && Array.isArray(elements.headings) && elements.headings.length > 0) {
      lines.push('\n## 标题')
      elements.headings.forEach((h: unknown) => {
        const heading = h as { tag?: string; text?: string }
        if (heading.text) {
          lines.push(`- [${heading.tag || 'h'}] ${heading.text}`)
        }
      })
    }

    if (elements.buttons && Array.isArray(elements.buttons) && elements.buttons.length > 0) {
      lines.push('\n## 按钮')
      elements.buttons.slice(0, 10).forEach((b: string) => {
        lines.push(`- ${b}`)
      })
    }
  }

  return lines.join('\n')
}

/**
 * 创建浏览器工具
 */
export function createBrowserAdapterTool(): Tool {
  return browserAdapterTool
}
