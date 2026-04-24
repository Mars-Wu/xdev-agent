// src/mcp/client.ts
// MCP 客户端实现

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type {
  MCPServerConfig,
  MCPToolDefinition,
  MCPResource,
  MCPPrompt,
  MCPConnectionStatus,
  MCPToolResult,
  IMCPClient,
} from './types'
import { createLogger } from '../utils/logger'

const logger = createLogger('mcp-client')

/**
 * MCP 客户端
 */
export class MCPClient implements IMCPClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private config: MCPServerConfig
  private status: MCPConnectionStatus = 'disconnected'
  private lastError?: string

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(): Promise<void> {
    if (this.status === 'connected') {
      return
    }

    this.status = 'connecting'
    this.lastError = undefined

    try {
      if (this.config.command) {
        // Stdio 传输模式
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args || [],
          env: { ...process.env, ...this.config.env } as Record<string, string>,
        })

        this.client = new Client(
          { name: 'xdev-mcp-client', version: '1.0.0' },
          {
            capabilities: {},
          }
        )

        await this.client.connect(this.transport)
        this.status = 'connected'
        logger.info(`MCP 服务器已连接: ${this.config.name}`)
      } else if (this.config.url) {
        // WebSocket 模式 - 暂不支持
        throw new Error('WebSocket 传输模式暂不支持')
      } else {
        throw new Error('缺少 command 或 url 配置')
      }
    } catch (error) {
      this.status = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      logger.error(`MCP 连接失败: ${this.config.name}`, error)
      throw error
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        // 忽略关闭错误
      }
      this.client = null
    }

    if (this.transport) {
      try {
        this.transport.close()
      } catch {
        // 忽略关闭错误
      }
      this.transport = null
    }

    this.status = 'disconnected'
    logger.info(`MCP 服务器已断开: ${this.config.name}`)
  }

  /**
   * 获取可用工具列表
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    this.ensureConnected()
    const result = await this.client!.listTools()
    return result.tools as MCPToolDefinition[]
  }

  /**
   * 获取资源列表
   */
  async listResources(): Promise<MCPResource[]> {
    this.ensureConnected()
    const result = await this.client!.listResources()
    return result.resources as MCPResource[]
  }

  /**
   * 获取提示词列表
   */
  async listPrompts(): Promise<MCPPrompt[]> {
    this.ensureConnected()
    const result = await this.client!.listPrompts()
    return result.prompts as MCPPrompt[]
  }

  /**
   * 调用工具
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<MCPToolResult> {
    this.ensureConnected()

    const result = await this.client!.callTool({
      name,
      arguments: args,
    })

    return result as MCPToolResult
  }

  /**
   * 读取资源
   */
  async readResource(uri: string): Promise<unknown> {
    this.ensureConnected()
    const result = await this.client!.readResource({ uri })
    return result.contents
  }

  /**
   * 获取连接状态
   */
  getStatus(): MCPConnectionStatus {
    return this.status
  }

  /**
   * 获取最后的错误
   */
  getLastError(): string | undefined {
    return this.lastError
  }

  /**
   * 获取服务器名称
   */
  getName(): string {
    return this.config.name
  }

  /**
   * 确保已连接
   */
  private ensureConnected(): void {
    if (!this.client || this.status !== 'connected') {
      throw new Error(`MCP 服务器未连接: ${this.config.name}`)
    }
  }
}

/**
 * 创建 MCP 客户端
 */
export function createMCPClient(config: MCPServerConfig): MCPClient {
  return new MCPClient(config)
}
