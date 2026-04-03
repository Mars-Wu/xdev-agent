// src/mcp/types.ts
// MCP 类型定义

/**
 * MCP 服务器配置
 */
export interface MCPServerConfig {
  /** 服务器名称 */
  name: string
  /** 启动命令 (stdio 模式) */
  command?: string
  /** WebSocket URL (websocket 模式) */
  url?: string
  /** 命令行参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** 是否禁用 */
  disabled?: boolean
  /** 超时时间 (毫秒) */
  timeout?: number
}

/**
 * MCP 配置文件
 */
export interface MCPConfig {
  servers: MCPServerConfig[]
}

/**
 * MCP 工具定义
 */
export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, MCPPropertySchema>
    required?: string[]
  }
}

/**
 * MCP 属性 Schema
 */
export interface MCPPropertySchema {
  type: string
  description?: string
  enum?: string[]
  default?: unknown
}

/**
 * MCP 资源
 */
export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/**
 * MCP 提示词
 */
export interface MCPPrompt {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

/**
 * MCP 服务器连接状态
 */
export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

/**
 * MCP 服务器信息
 */
export interface MCPServerInfo {
  name: string
  status: MCPConnectionStatus
  tools: MCPToolDefinition[]
  resources: MCPResource[]
  prompts: MCPPrompt[]
  error?: string
}

/**
 * MCP 调用结果
 */
export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

/**
 * MCP 客户端接口
 */
export interface IMCPClient {
  connect(): Promise<void>
  disconnect(): Promise<void>
  listTools(): Promise<MCPToolDefinition[]>
  listResources(): Promise<MCPResource[]>
  listPrompts(): Promise<MCPPrompt[]>
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>
  readResource(uri: string): Promise<unknown>
  getStatus(): MCPConnectionStatus
}
