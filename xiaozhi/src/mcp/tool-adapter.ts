// src/mcp/tool-adapter.ts
// MCP 工具适配器

import type { Tool, ToolResult, ToolParameterSchema } from '../tools/tool-interface'
import { successResult, errorResult } from '../tools/tool-interface'
import type { IMCPClient, MCPToolDefinition, MCPPropertySchema } from './types'
import { createLogger } from '../utils/logger'

const logger = createLogger('mcp-adapter')

/**
 * 创建 MCP 工具适配器
 * 将 MCP 工具转换为 xiaozhi 工具格式
 */
export function createMCPToolAdapter(
  serverName: string,
  toolDef: MCPToolDefinition,
  client: IMCPClient
): Tool {
  const toolName = `mcp_${serverName}_${toolDef.name}`

  return {
    definition: {
      name: toolName,
      description: `[MCP/${serverName}] ${toolDef.description}`,
      parameters: convertMCPSchemaToParams(toolDef.inputSchema.properties),
      required: toolDef.inputSchema.required || [],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        logger.debug(`调用 MCP 工具: ${toolName}`, params)

        const result = await client.callTool(toolDef.name, params)

        return successResult(formatMCPResult(result))
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`MCP 工具调用失败: ${toolName}`, error)
        return errorResult(`MCP 工具调用失败: ${errorMsg}`)
      }
    },
  }
}

/**
 * 转换 MCP Schema 到 xiaozhi 参数格式
 */
function convertMCPSchemaToParams(
  properties: Record<string, MCPPropertySchema>
): Record<string, ToolParameterSchema> {
  const params: Record<string, ToolParameterSchema> = {}

  for (const [key, prop] of Object.entries(properties)) {
    params[key] = {
      type: (prop.type || 'string') as 'string' | 'number' | 'boolean' | 'object' | 'array',
      description: prop.description || '',
      ...(prop.enum ? { enum: prop.enum } : {}),
      ...(prop.default !== undefined ? { default: prop.default } : {}),
    }
  }

  return params
}

/**
 * 格式化 MCP 结果
 */
function formatMCPResult(result: {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}): string {
  if (!result.content || result.content.length === 0) {
    return '(无输出)'
  }

  const parts: string[] = []

  for (const item of result.content) {
    switch (item.type) {
      case 'text':
        parts.push(item.text || '')
        break
      case 'image':
        parts.push(`[图片: ${item.mimeType || 'unknown'}]`)
        break
      case 'resource':
        parts.push(`[资源: ${item.text || 'unknown'}]`)
        break
      default:
        parts.push(JSON.stringify(item))
    }
  }

  return parts.join('\n')
}
