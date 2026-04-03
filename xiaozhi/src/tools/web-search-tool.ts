// src/tools/web-search-tool.ts
// 网络搜索工具
import { createLogger } from '../utils/logger'
import type { Tool, ToolResult, ToolParameterSchema } from './tool-interface'
import { successResult, errorResult } from './tool-interface'
import { spawn } from 'child_process'

const logger = createLogger('web-search-tool')

/**
 * Web Search 工具定义
 */
const webSearchToolDefinition = {
  name: 'web_search',
  description:
    '搜索网络获取最新信息。支持通用搜索，返回相关结果和链接。',
  parameters: {
    query: {
      type: 'string' as const,
      description: '搜索查询',
    },
    max_results: {
      type: 'number' as const,
      description: '最大结果数（默认 5）',
      default: 5,
    },
    allowed_domains: {
      type: 'array' as const,
      description: '限制搜索的域名列表',
      items: { type: 'string' as const },
    },
    blocked_domains: {
      type: 'array' as const,
      description: '排除的域名列表',
      items: { type: 'string' as const },
    },
  } as Record<string, ToolParameterSchema>,
  required: ['query'],
  dangerous: false,
  readOnly: true,
}

 /**
 * Web Search 工具实现
 */
export const webSearchTool: Tool = {
  definition: webSearchToolDefinition,
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string
    const maxResults = (params.max_results as number) || 5
    if (!query) {
      return errorResult('缺少 query 参数')
    }
    try {
      // 检查是否配置了搜索 API
      const apiKey = process.env.SERP_API_KEY || process.env.BING_API_KEY
      if (!apiKey) {
        return successResult(
          '网络搜索功能需要配置搜索 API。\n\n' +
            '配置方法:\n' +
            '1. Serper API: 设置 SERP_API_KEY 环境变量\n' +
            '   获取地址: https://serper.dev/\n\n' +
            '2. Bing API: 设置 BING_API_KEY 环境变量\n' +
            '   获取地址: https://azure.microsoft.com/services/cognitive-services/bing-web-search-api/',
          { requiresConfig: true }
        )
      }
      // 使用 Serper API
      if (process.env.SERP_API_KEY) {
        return await searchWithSerper(query, maxResults)
      }
      // 使用 Bing API
      if (process.env.BING_API_KEY) {
        return await searchWithBing(query, maxResults)
      }
      return errorResult('未配置有效的搜索 API')
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Web 搜索失败: ${query}`, error)
      return errorResult(`搜索失败: ${errorMsg}`)
    }
  },
}
 /**
 * 使用 Serper API 搜索
 */
async function searchWithSerper(
  query: string,
  maxResults: number
): Promise<ToolResult> {
  const apiKey = process.env.SERP_API_KEY!
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
    }),
  })
  if (!response.ok) {
    throw new Error(`Serper API 错误: ${response.status}`)
  }
  const data = await response.json()
  const results = ((data as { organic?: Array<{ title: string; link: string; snippet: string }> }).organic || []).slice(0, maxResults)
  let output = `搜索结果: "${query}"\n\n`
  for (const result of results) {
    output += `## ${result.title}\n`
    output += `${result.link}\n`
    output += `${result.snippet}\n\n`
  }
  output += '\n---\nSources:\n'
  for (const result of results) {
    output += `- [${result.title}](${result.link})\n`
  }
  logger.info(`Web 搜索: ${query} -> ${results.length} 个结果`)
  return successResult(output, { count: results.length, results })
}
 /**
 * 使用 Bing API 搜索
 */
async function searchWithBing(
  query: string,
  maxResults: number
): Promise<ToolResult> {
  const apiKey = process.env.BING_API_KEY!
  const url = new URL('https://api.bing.microsoft.com/v7.0/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(maxResults))
  url.searchParams.set('responseFilter', 'Webpages')
  const response = await fetch(url.toString(), {
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
    },
  })
  if (!response.ok) {
    throw new Error(`Bing API 错误: ${response.status}`)
  }
  interface BingResult {
    name: string
    url: string
    snippet: string
  }
  const data = await response.json()
  const results = ((data as { webPages?: { value: BingResult[] } }).webPages?.value || []).slice(0, maxResults)
  let output = `搜索结果: "${query}"\n\n`
  for (const result of results) {
    output += `## ${result.name}\n`
    output += `${result.url}\n`
    output += `${result.snippet}\n\n`
  }
  output += '\n---\nSources:\n'
  for (const result of results) {
    output += `- [${result.name}](${result.url})\n`
  }
  logger.info(`Bing 搜索: ${query} -> ${results.length} 个结果`)
  return successResult(output, { count: results.length, results })
    }
/**
 * 创建 Web Search 工具
 */
export function createWebSearchTool(): Tool {
  return webSearchTool
}
