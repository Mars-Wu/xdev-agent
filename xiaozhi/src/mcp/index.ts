// src/mcp/index.ts
// MCP 模块导出

// 类型
export type {
  MCPServerConfig,
  MCPConfig,
  MCPToolDefinition,
  MCPPropertySchema,
  MCPResource,
  MCPPrompt,
  MCPConnectionStatus,
  MCPServerInfo,
  MCPToolResult,
  IMCPClient,
} from './types'

// 客户端
export { MCPClient, createMCPClient } from './client'

// 服务器管理
export {
  MCPServerManager,
  getMCPServerManager,
  resetMCPServerManager,
} from './server-manager'

// 工具适配
export { createMCPToolAdapter } from './tool-adapter'
