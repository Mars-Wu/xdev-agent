// src/tools/web-fetch-tool.ts
// 网页获取工具
import { createLogger } from '../utils/logger'
import type { Tool, ToolResult, ToolParameterSchema } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import * as cheerio from 'cheerio'
const logger = createLogger('web-fetch-tool')
 /**
 * Web Fetch 工具定义
 */
const webFetchToolDefinition = {
  name: 'web_fetch',
  description:
    '获取网页内容并转换为可读格式。支持 HTML 转 Markdown,提取主要文本内容。',
  parameters: {
    url: {
      type: 'string' as const,
      description: '要获取的 URL',
    },
    format: {
      type: 'string' as const,
      description: '返回格式: markdown, text, html',
      enum: ['markdown', 'text', 'html'],
      default: 'markdown',
    },
    selector: {
      type: 'string' as const,
      description: 'CSS 选择器，提取特定元素（可选）',
    },
    timeout: {
      type: 'number' as const,
      description: '超时时间(毫秒，默认 30000)',
      default: 30000,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['url'],
  dangerous: false,
  readOnly: true,
}
 /**
 * Web Fetch 工具实现
 */
export const webFetchTool: Tool = {
  definition: webFetchToolDefinition,
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string
    const format = (params.format as string) || 'markdown'
    const selector = params.selector as string | undefined
    const timeout = (params.timeout as number) || 30000
    if (!url) {
      return errorResult('缺少 url 参数')
    }
    // 验证 URL
    try {
      new URL(url)
    } catch {
      return errorResult('无效的 URL 格式')
    }
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; XiaozhiBot/1.0; +https://github.com/xiaozhi)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
      clearTimeout(timeoutId)
      if (!response.ok) {
        return errorResult(`HTTP 错误: ${response.status} ${response.statusText}`)
      }
      const contentType = response.headers.get('content-type') || ''
      // 处理非 HTML 内容
      if (!contentType.includes('text/html')) {
        if (contentType.includes('application/json')) {
          const json = await response.json()
          return successResult(JSON.stringify(json, null, 2), {
            contentType,
            json: true,
          })
        }
        const text = await response.text()
        return successResult(text.slice(0, 50000), { contentType })
      }
      const html = await response.text()
      const $ = cheerio.load(html)
      // 移除不需要的元素
      $('script, style, nav, header, footer, aside, .ads, .sidebar').remove()
      // 提取特定元素
      let content = ''
      if (selector) {
        content = $(selector).html() || ''
      } else {
        // 尝试提取主要内容
        const mainSelectors = [
          'article',
          'main',
          '.content',
          '.post-content',
          '.article-content',
          '#content',
        ]
        for (const sel of mainSelectors) {
          const el = $(sel)
          if (el.length && el.text().length > 200) {
            content = el.html() || ''
            break
          }
        }
        if (!content) {
          content = $('body').html() || ''
        }
      }
      // 转换格式
      let output: string
      switch (format) {
        case 'html':
          output = content
          break
        case 'text':
          output = cheerio.load(content).text()
          break
        case 'markdown':
        default:
          output = htmlToMarkdown(content, url)
          break
      }
      // 提取元信息
      const title = $('title').text() || ''
      const description = $('meta[name="description"]').attr('content') || ''
      // 限制输出长度
      const maxLength = 50000
      if (output.length > maxLength) {
        output = output.slice(0, maxLength) + '\n\n... (内容已截断)'
      }
      logger.info(`Web Fetch: ${url} -> ${output.length} 字符`)
      return successResult(
        `# ${title}\n\n${description ? `> ${description}\n\n` : ''}${output}`,
        {
          url,
          title,
          description,
          format,
          length: output.length,
        }
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return errorResult('请求超时')
      }
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Web Fetch 失败: ${url}`, error)
      return errorResult(`获取失败: ${errorMsg}`)
    }
  },
}
 /**
 * 简单的 HTML 转 Markdown
 */
function htmlToMarkdown(html: string, baseUrl: string): string {
  const $ = cheerio.load(html)
  // 处理常见元素
  let markdown = ''
  $('*').each((_, el) => {
    const $el = $(el)
    // Check if el is an Element (has tagName)
    if ('tagName' in el === false) return
    const tag = el.tagName?.toLowerCase()
    if (!tag) return
    const text = $el.text().trim()
    if (!text && !['img', 'br', 'hr'].includes(tag)) return
    switch (tag) {
      case 'h1':
        markdown += `# ${text}\n\n`
        break
      case 'h2':
        markdown += `## ${text}\n\n`
        break
      case 'h3':
        markdown += `### ${text}\n\n`
        break
      case 'h4':
        markdown += `#### ${text}\n\n`
        break
      case 'h5':
        markdown += `##### ${text}\n\n`
        break
      case 'h6':
        markdown += `###### ${text}\n\n`
        break
      case 'p':
        markdown += `${text}\n\n`
        break
      case 'br':
        markdown += '\n'
        break
      case 'hr':
        markdown += '\n---\n\n'
        break
      case 'a':
        const href = $el.attr('href')
        if (href && text) {
          try {
            const fullUrl = new URL(href, baseUrl).toString()
            markdown += `[${text}](${fullUrl})`
          } catch {
            markdown += `[${text}](${href})`
          }
        }
        break
      case 'img':
        const src = $el.attr('src')
        const alt = $el.attr('alt') || ''
        if (src) {
          try {
            const fullUrl = new URL(src, baseUrl).toString()
            markdown += `![${alt}](${fullUrl})`
          } catch {
            markdown += `![${alt}](${src})`
          }
        }
        break
      case 'code':
        markdown += `\`${text}\``
        break
      case 'pre':
        markdown += `\n\`\`\`\n${text}\n\`\`\`\n\n`
        break
      case 'blockquote':
        markdown += `> ${text.replace(/\n/g, '\n> ')}\n\n`
        break
      case 'li':
        markdown += `- ${text}\n`
        break
      case 'strong':
      case 'b':
        markdown += `**${text}**`
        break
      case 'em':
      case 'i':
        markdown += `*${text}*`
        break
    }
  })
  // 清理多余空行
  return markdown.replace(/\n{3,}/g, '\n\n').trim()
}
 /**
 * 创建 Web Fetch 工具
 */
export function createWebFetchTool(): Tool {
  return webFetchTool
}
