// src/mcp/server-manager.ts
// MCP 服务器管理器

import * as path from 'path'
import * as fs from 'fs/promises'
import { MCPClient, createMCPClient } from './client'
import type {
  MCPServerConfig,
  MCPConfig,
  MCPToolDefinition,
  MCPServerInfo,
} from './types'
import { createLogger } from '../utils/logger'
import { getToolRegistry } from '../tools'
import { createMCPToolAdapter } from './tool-adapter'

const logger = createLogger('mcp-manager')

/**
 * MCP 服务器管理器
 */
export class MCPServerManager {
  private clients: Map<string, MCPClient> = new Map()
  private configs: Map<string, MCPServerConfig> = new Map()
  private configPath: string

  constructor(configPath?: string) {
    this.configPath =
      configPath ||
      path.join(process.env.HOME || '', '.xiaozhi', 'mcp-servers.json')
  }

  /**
   * 加载配置文件
   */
  async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8')
      const config = JSON.parse(content) as MCPConfig

      for (const server of config.servers) {
        this.registerServer(server)
      }

      logger.info(`已加载 ${this.configs.size} 个 MCP 服务器配置`)
    } catch (error) {
      // 配置文件不存在，创建默认配置
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.createDefaultConfig()
      } else {
        logger.warn('加载 MCP 配置失败:', error)
      }
    }
  }

  /**
   * 创建默认配置
   */
  private async createDefaultConfig(): Promise<void> {
    const defaultConfig: MCPConfig = {
      servers: [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@anthropic/mcp-server-filesystem', '/home/wxy/data'],
          disabled: false,
        },
      ],
    }

    await fs.mkdir(path.dirname(this.configPath), { recursive: true })
    await fs.writeFile(
      this.configPath,
      JSON.stringify(defaultConfig, null, 2),
      'utf-8'
    )

    for (const server of defaultConfig.servers) {
      this.registerServer(server)
    }

    logger.info('已创建默认 MCP 配置')
  }

  /**
   * 注册服务器配置
   */
  registerServer(config: MCPServerConfig): void {
    this.configs.set(config.name, config)
    logger.debug(`注册 MCP 服务器: ${config.name}`)
  }

  /**
   * 启动所有服务器
   */
  async startAll(): Promise<void> {
    for (const [name] of this.configs) {
      try {
        await this.startServer(name)
      } catch (error) {
        logger.error(`启动 MCP 服务器失败: ${name}`, error)
      }
    }
  }

  /**
   * 启动单个服务器
   */
  async startServer(name: string): Promise<void> {
    const config = this.configs.get(name)
    if (!config) {
      throw new Error(`服务器配置不存在: ${name}`)
    }

    if (config.disabled) {
      logger.info(`MCP 服务器已禁用: ${name}`)
      return
    }

    if (this.clients.has(name)) {
      logger.warn(`MCP 服务器已启动: ${name}`)
      return
    }

    const client = createMCPClient(config)
    await client.connect()
    this.clients.set(name, client)

    // 动态注册工具
    await this.registerTools(name, client)

    logger.info(`MCP 服务器已启动: ${name}`)
  }

  /**
   * 注册工具到工具注册表
   */
  private async registerTools(
    serverName: string,
    client: MCPClient
  ): Promise<void> {
    try {
      const tools = await client.listTools()
      const registry = getToolRegistry()

      for (const tool of tools) {
        const adapter = createMCPToolAdapter(serverName, tool, client)
        registry.register(adapter)
      }

      logger.info(
        `已注册 ${tools.length} 个 MCP 工具: ${serverName}`
      )
    } catch (error) {
      logger.error(`注册 MCP 工具失败: ${serverName}`, error)
    }
  }

  /**
   * 停止服务器
   */
  async stopServer(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      await client.disconnect()
      this.clients.delete(name)
      logger.info(`MCP 服务器已停止: ${name}`)
    }
  }

  /**
   * 停止所有服务器
   */
  async stopAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.disconnect()
      } catch (error) {
        logger.error(`停止 MCP 服务器失败: ${name}`, error)
      }
    }
    this.clients.clear()
  }

  /**
   * 获取服务器信息
   */
  async getServerInfo(name: string): Promise<MCPServerInfo | null> {
    const client = this.clients.get(name)
    const config = this.configs.get(name)

    if (!config) return null

    if (!client) {
      return {
        name,
        status: 'disconnected',
        tools: [],
        resources: [],
        prompts: [],
      }
    }

    try {
      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ])

      return {
        name,
        status: client.getStatus(),
        tools,
        resources,
        prompts,
        error: client.getLastError(),
      }
    } catch (error) {
      return {
        name,
        status: 'error',
        tools: [],
        resources: [],
        prompts: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 获取所有服务器信息
   */
  async getAllServerInfo(): Promise<MCPServerInfo[]> {
    const infos: MCPServerInfo[] = []

    for (const [name] of this.configs) {
      const info = await this.getServerInfo(name)
      if (info) infos.push(info)
    }

    return infos
  }

  /**
   * 获取所有可用工具
   */
  async getAllTools(): Promise<
    Array<{ server: string; tool: MCPToolDefinition }>
  > {
    const result: Array<{ server: string; tool: MCPToolDefinition }> = []

    for (const [name, client] of this.clients) {
      try {
        const tools = await client.listTools()
        for (const tool of tools) {
          result.push({ server: name, tool })
        }
      } catch (error) {
        logger.warn(`获取工具列表失败: ${name}`, error)
      }
    }

    return result
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const client = this.clients.get(serverName)
    if (!client) {
      throw new Error(`MCP 服务器未连接: ${serverName}`)
    }

    return await client.callTool(toolName, args)
  }

  /**
   * 重新加载配置
   */
  async reload(): Promise<void> {
    await this.stopAll()
    this.configs.clear()
    await this.loadConfig()
    await this.startAll()
  }
}

// 单例
let manager: MCPServerManager | null = null

/**
 * 获取 MCP 服务器管理器
 */
export function getMCPServerManager(): MCPServerManager {
  if (!manager) {
    manager = new MCPServerManager()
  }
  return manager
}

/**
 * 重置 MCP 服务器管理器
 */
export function resetMCPServerManager(): void {
  if (manager) {
    manager.stopAll().catch(() => {})
  }
  manager = null
}
