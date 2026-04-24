# 艾克斯工具系统扩展计划

> 创建时间：2026-04-02
> 目标：实现 MCP、Skill 及其他核心工具

---

## 目录

1. [概述](#1-概述)
2. [Phase 1: MCP & Skill (P0)](#2-phase-1-mcp--skill-p0)
3. [Phase 2: 工具完善 (P1)](#3-phase-2-工具完善-p1)
4. [Phase 3: 高级功能 (P2)](#4-phase-3-高级功能-p2)
5. [文件结构](#5-文件结构)
6. [实现优先级](#6-实现优先级)

---

## 1. 概述

### 1.1 当前状态

| 工具类型 | 状态 | 说明 |
|----------|------|------|
| bashTool | ✅ 已注册 | Shell 命令执行 |
| readTool | ✅ 已注册 | 文件读取 |
| writeTool | ✅ 已注册 | 文件写入 |
| editTool | ✅ 已注册 | 文件编辑 |
| listTool | ✅ 已注册 | 目录列表 |
| BrowserTool | ⚠️ 未注册 | 浏览器自动化（独立类） |
| MCPTool | ❌ 未实现 | MCP 协议支持 |
| SkillTool | ❌ 未实现 | 用户自定义技能 |

### 1.2 目标架构

```
xdev 工具系统
├── 内置工具 (Built-in)
│   ├── BashTool
│   ├── FileTools (Read/Write/Edit/List)
│   ├── GlobTool
│   ├── GrepTool
│   ├── WebFetchTool
│   ├── WebSearchTool
│   └── BrowserTool
│
├── MCP 工具 (动态)
│   ├── MCPClient
│   ├── MCPServerManager
│   └── MCPToolAdapter (动态注册)
│
├── Skill 工具 (用户定义)
│   ├── SkillLoader
│   ├── SkillRegistry
│   └── SkillTool
│
└── 高级工具
    ├── AgentTool
    ├── TaskTools (Create/Get/Stop/Output)
    ├── LSPTool
    └── ScheduleCronTool
```

---

## 2. Phase 1: MCP & Skill (P0)

### 2.1 MCP 工具系统

#### 2.1.1 MCP 协议概述

Model Context Protocol (MCP) 是 Anthropic 定义的标准化协议，用于 AI 模型与外部工具/资源通信。

```
MCP 架构:
┌─────────────┐     JSON-RPC     ┌─────────────┐
│  MCP Client │ ←──────────────→ │ MCP Server  │
│  (xdev)  │                  │ (playwright)│
└─────────────┘                  └─────────────┘
                                       │
                                       ▼
                                 ┌─────────────┐
                                 │   Tools     │
                                 │  Resources  │
                                 │  Prompts    │
                                 └─────────────┘
```

#### 2.1.2 需要实现的模块

```
src/mcp/
├── index.ts              # 导出
├── types.ts              # 类型定义
├── client.ts             # MCP 客户端
├── server-manager.ts     # 服务器管理
├── tool-adapter.ts       # 工具适配器
└── transport/
    ├── stdio.ts          # 标准输入输出传输
    └── websocket.ts      # WebSocket 传输
```

#### 2.1.3 类型定义

```typescript
// src/mcp/types.ts

/**
 * MCP 服务器配置
 */
export interface MCPServerConfig {
  name: string
  command?: string        // 启动命令 (stdio)
  url?: string           // WebSocket URL
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
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
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
```

#### 2.1.4 MCP 客户端实现

```typescript
// src/mcp/client.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { MCPServerConfig, MCPToolDefinition, MCPResource } from './types'

export class MCPClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null
  private config: MCPServerConfig

  constructor(config: MCPServerConfig) {
    this.config = config
  }

  /**
   * 连接到 MCP 服务器
   */
  async connect(): Promise<void> {
    if (this.config.command) {
      // Stdio 传输
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env: { ...process.env, ...this.config.env },
      })

      this.client = new Client(
        { name: 'xdev-mcp-client', version: '1.0.0' },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
      )

      await this.client.connect(this.transport)
    }
  }

  /**
   * 获取可用工具列表
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) throw new Error('未连接')
    const result = await this.client.listTools()
    return result.tools
  }

  /**
   * 调用工具
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('未连接')
    const result = await this.client.callTool({ name, arguments: args })
    return result.content
  }

  /**
   * 获取资源列表
   */
  async listResources(): Promise<MCPResource[]> {
    if (!this.client) throw new Error('未连接')
    const result = await this.client.listResources()
    return result.resources
  }

  /**
   * 读取资源
   */
  async readResource(uri: string): Promise<unknown> {
    if (!this.client) throw new Error('未连接')
    const result = await this.client.readResource({ uri })
    return result.contents
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
    }
    if (this.transport) {
      this.transport.close()
      this.transport = null
    }
  }
}
```

#### 2.1.5 MCP 服务器管理器

```typescript
// src/mcp/server-manager.ts

import { MCPClient } from './client'
import type { MCPServerConfig, MCPToolDefinition } from './types'
import { getToolRegistry } from '../tools'
import { createMCPToolAdapter } from './tool-adapter'

export class MCPServerManager {
  private servers: Map<string, MCPClient> = new Map()
  private configs: Map<string, MCPServerConfig> = new Map()

  /**
   * 注册 MCP 服务器配置
   */
  registerServer(config: MCPServerConfig): void {
    this.configs.set(config.name, config)
  }

  /**
   * 启动所有服务器
   */
  async startAll(): Promise<void> {
    for (const [name, config] of this.configs) {
      if (config.disabled) continue
      await this.startServer(name)
    }
  }

  /**
   * 启动单个服务器
   */
  async startServer(name: string): Promise<void> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`服务器配置不存在: ${name}`)

    const client = new MCPClient(config)
    await client.connect()
    this.servers.set(name, client)

    // 动态注册工具
    const tools = await client.listTools()
    const registry = getToolRegistry()

    for (const tool of tools) {
      const adapter = createMCPToolAdapter(name, tool, client)
      registry.register(adapter)
    }
  }

  /**
   * 停止服务器
   */
  async stopServer(name: string): Promise<void> {
    const client = this.servers.get(name)
    if (client) {
      await client.disconnect()
      this.servers.delete(name)
    }
  }

  /**
   * 获取所有可用工具
   */
  async getAllTools(): Promise<Array<{ server: string; tool: MCPToolDefinition }>> {
    const result: Array<{ server: string; tool: MCPToolDefinition }> = []

    for (const [name, client] of this.servers) {
      const tools = await client.listTools()
      for (const tool of tools) {
        result.push({ server: name, tool })
      }
    }

    return result
  }
}
```

#### 2.1.6 MCP 工具适配器

```typescript
// src/mcp/tool-adapter.ts

import type { Tool, ToolResult } from '../tools'
import { successResult, errorResult } from '../tools'
import type { MCPClient, MCPToolDefinition } from './types'

/**
 * 创建 MCP 工具适配器
 * 将 MCP 工具转换为 xdev 工具格式
 */
export function createMCPToolAdapter(
  serverName: string,
  toolDef: MCPToolDefinition,
  client: MCPClient,
): Tool {
  return {
    definition: {
      name: `mcp_${serverName}_${toolDef.name}`,
      description: `[MCP/${serverName}] ${toolDef.description}`,
      parameters: convertMCPSchemaToParams(toolDef.inputSchema),
      required: toolDef.inputSchema.required || [],
      dangerous: false,
      readOnly: false,
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await client.callTool(toolDef.name, params)
        return successResult(formatMCPResult(result))
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/**
 * 转换 MCP Schema 到 xdev 参数格式
 */
function convertMCPSchemaToParams(schema: MCPToolDefinition['inputSchema']): Record<string, unknown> {
  const params: Record<string, unknown> = {}

  for (const [key, prop] of Object.entries(schema.properties)) {
    params[key] = {
      type: prop.type || 'string',
      description: prop.description || '',
    }
  }

  return params
}

/**
 * 格式化 MCP 结果
 */
function formatMCPResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result.map(item => {
      if (typeof item === 'object' && item !== null) {
        if ('text' in item) return item.text
        if ('content' in item) return item.content
      }
      return JSON.stringify(item)
    }).join('\n')
  }
  return JSON.stringify(result, null, 2)
}
```

#### 2.1.7 MCP 配置文件

```json
// ~/.xdev/mcp-servers.json
{
  "servers": [
    {
      "name": "playwright",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-puppeteer"],
      "disabled": false
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/home/wxy/data"],
      "disabled": false
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      },
      "disabled": false
    }
  ]
}
```

---

### 2.2 Skill 工具系统

#### 2.2.1 Skill 概述

Skill 是用户自定义的可复用提示词模板，可以包含：
- 系统提示词
- 参数定义
- 示例对话

```
Skill 格式 (.md 文件):
---
name: code-review
description: 代码审查专家
parameters:
  - name: language
    description: 编程语言
    required: true
  - name: focus
    description: 关注点 (security/performance/style)
    required: false
---

# 代码审查专家

你是一个专业的代码审查专家，专注于 {{language}} 代码。

## 关注点
{{#if focus}}
重点关注: {{focus}}
{{else}}
全面审查代码质量
{{/if}}

## 审查清单
- 代码风格
- 潜在 bug
- 性能问题
- 安全漏洞
```

#### 2.2.2 需要实现的模块

```
src/skills/
├── index.ts              # 导出
├── types.ts              # 类型定义
├── loader.ts             # 技能加载器
├── registry.ts           # 技能注册表
├── executor.ts           # 技能执行器
└── builtins/             # 内置技能
    ├── code-review.md
    ├── git-expert.md
    └── translator.md
```

#### 2.2.3 类型定义

```typescript
// src/skills/types.ts

/**
 * Skill 参数定义
 */
export interface SkillParameter {
  name: string
  description?: string
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
  default?: unknown
}

/**
 * Skill 定义
 */
export interface SkillDefinition {
  name: string
  description?: string
  version?: string
  author?: string
  parameters?: SkillParameter[]
  systemPrompt: string
  examples?: Array<{
    input: Record<string, unknown>
    output?: string
  }>
}

/**
 * Skill 文件元数据 (frontmatter)
 */
export interface SkillFrontmatter {
  name: string
  description?: string
  version?: string
  author?: string
  parameters?: SkillParameter[]
  model?: string
  temperature?: number
  maxTokens?: number
}

/**
 * Skill 执行上下文
 */
export interface SkillExecutionContext {
  skillName: string
  parameters: Record<string, unknown>
  conversationHistory?: Message[]
  workingDirectory?: string
}
```

#### 2.2.4 Skill 加载器

```typescript
// src/skills/loader.ts

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { SkillDefinition, SkillFrontmatter } from './types'

const logger = createLogger('skill-loader')

/**
 * 解析 frontmatter
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

  if (!match) {
    return { frontmatter: { name: '' }, body: content }
  }

  const frontmatterText = match[1]
  const body = match[2]

  // 简单 YAML 解析
  const frontmatter: Record<string, unknown> = {}
  const lines = frontmatterText.split('\n')
  let currentKey = ''
  let currentArray: unknown[] | null = null

  for (const line of lines) {
    const arrayItemMatch = line.match(/^\s*-\s+(.+)$/)
    if (arrayItemMatch && currentArray) {
      currentArray.push(arrayItemMatch[1])
      continue
    }

    const match = line.match(/^(\w+):\s*(.*)$/)
    if (match) {
      currentKey = match[1]
      const value = match[2].trim()

      if (value === '') {
        currentArray = []
        frontmatter[currentKey] = currentArray
      } else if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[currentKey] = JSON.parse(value)
      } else if (value === 'true' || value === 'false') {
        frontmatter[currentKey] = value === 'true'
      } else if (!isNaN(Number(value))) {
        frontmatter[currentKey] = Number(value)
      } else {
        frontmatter[currentKey] = value
      }
    }
  }

  return { frontmatter: frontmatter as SkillFrontmatter, body }
}

/**
 * 加载单个 Skill 文件
 */
export async function loadSkill(filepath: string): Promise<SkillDefinition> {
  const content = await fs.readFile(filepath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter(content)

  if (!frontmatter.name) {
    frontmatter.name = path.basename(filepath, '.md')
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    version: frontmatter.version,
    author: frontmatter.author,
    parameters: frontmatter.parameters,
    systemPrompt: body.trim(),
  }
}

/**
 * 加载目录下所有 Skill
 */
export async function loadSkillsFromDirectory(dir: string): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  try {
    const files = await fs.readdir(dir)

    for (const file of files) {
      if (file.endsWith('.md')) {
        try {
          const skill = await loadSkill(path.join(dir, file))
          skills.push(skill)
          logger.info(`加载技能: ${skill.name}`)
        } catch (error) {
          logger.warn(`加载技能失败: ${file}`, error)
        }
      }
    }
  } catch {
    // 目录不存在，忽略
  }

  return skills
}
```

#### 2.2.5 Skill 注册表

```typescript
// src/skills/registry.ts

import { createLogger } from '../utils/logger'
import type { SkillDefinition } from './types'
import { loadSkillsFromDirectory, loadSkill } from './loader'
import * as path from 'path'
import * as fs from 'fs/promises'

const logger = createLogger('skill-registry')

/**
 * Skill 注册表
 */
export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map()
  private skillsDir: string

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir
  }

  /**
   * 初始化 - 加载所有技能
   */
  async initialize(): Promise<void> {
    // 确保目录存在
    await fs.mkdir(this.skillsDir, { recursive: true })

    // 加载内置技能
    const builtinsDir = path.join(__dirname, 'builtins')
    const builtins = await loadSkillsFromDirectory(builtinsDir)
    for (const skill of builtins) {
      this.skills.set(skill.name, skill)
    }

    // 加载用户技能
    const userSkills = await loadSkillsFromDirectory(this.skillsDir)
    for (const skill of userSkills) {
      this.skills.set(skill.name, skill)
    }

    logger.info(`已加载 ${this.skills.size} 个技能`)
  }

  /**
   * 获取技能
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  /**
   * 列出所有技能
   */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  /**
   * 注册技能
   */
  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill)
    logger.info(`注册技能: ${skill.name}`)
  }

  /**
   * 注销技能
   */
  unregister(name: string): boolean {
    return this.skills.delete(name)
  }

  /**
   * 重新加载技能
   */
  async reload(name: string): Promise<boolean> {
    const filepath = path.join(this.skillsDir, `${name}.md`)
    try {
      const skill = await loadSkill(filepath)
      this.skills.set(name, skill)
      return true
    } catch {
      return false
    }
  }
}

// 单例
let registry: SkillRegistry | null = null

export function getSkillRegistry(): SkillRegistry {
  if (!registry) {
    const skillsDir = path.join(process.env.HOME || '', '.xdev', 'skills')
    registry = new SkillRegistry(skillsDir)
  }
  return registry
}
```

#### 2.2.6 Skill 执行器

```typescript
// src/skills/executor.ts

import { getLLMClient } from '../core'
import { getSkillRegistry } from './registry'
import type { SkillDefinition, SkillExecutionContext } from './types'
import { createLogger } from '../utils/logger'

const logger = createLogger('skill-executor')

/**
 * 渲染模板
 */
function renderTemplate(template: string, params: Record<string, unknown>): string {
  let result = template

  // 替换 {{param}} 形式的变量
  for (const [key, value] of Object.entries(params)) {
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g')
    result = result.replace(regex, String(value ?? ''))
  }

  // 处理条件块 {{#if param}}...{{/if}}
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => {
    return params[key] ? content : ''
  })

  return result
}

/**
 * Skill 执行器
 */
export class SkillExecutor {
  /**
   * 执行技能
   */
  async execute(
    skillName: string,
    params: Record<string, unknown>,
    userMessage?: string,
  ): Promise<string> {
    const registry = getSkillRegistry()
    const skill = registry.get(skillName)

    if (!skill) {
      throw new Error(`技能不存在: ${skillName}`)
    }

    // 验证必需参数
    if (skill.parameters) {
      for (const param of skill.parameters) {
        if (param.required && !(param.name in params)) {
          throw new Error(`缺少必需参数: ${param.name}`)
        }
      }
    }

    // 渲染系统提示词
    const systemPrompt = renderTemplate(skill.systemPrompt, params)

    // 调用 LLM
    const llmClient = getLLMClient()
    const messages = userMessage ? [{ role: 'user' as const, content: userMessage }] : []

    const response = await llmClient.chatSync({
      model: process.env.XDEV_MODEL || 'glm-5',
      maxTokens: 16000,
      messages,
      system: systemPrompt,
    })

    logger.info(`技能执行完成: ${skillName}`)
    return response.content
  }
}

// 单例
let executor: SkillExecutor | null = null

export function getSkillExecutor(): SkillExecutor {
  if (!executor) {
    executor = new SkillExecutor()
  }
  return executor
}
```

#### 2.2.7 Skill 工具注册

```typescript
// src/skills/skill-tool.ts

import type { Tool, ToolResult } from '../tools'
import { successResult, errorResult } from '../tools'
import { getSkillRegistry, SkillRegistry } from './registry'
import { getSkillExecutor } from './executor'
import { createLogger } from '../utils/logger'

const logger = createLogger('skill-tool')

/**
 * 创建 Skill 工具
 */
export function createSkillTool(): Tool {
  return {
    definition: {
      name: 'skill',
      description: '执行用户定义的技能。技能是可复用的提示词模板。',
      parameters: {
        name: {
          type: 'string',
          description: '技能名称',
        },
        params: {
          type: 'object',
          description: '技能参数',
        },
        message: {
          type: 'string',
          description: '用户消息（可选）',
        },
      },
      required: ['name'],
      dangerous: false,
      readOnly: false,
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const skillName = params.name as string
      const skillParams = (params.params as Record<string, unknown>) || {}
      const message = params.message as string | undefined

      if (!skillName) {
        return errorResult('缺少技能名称')
      }

      try {
        const executor = getSkillExecutor()
        const result = await executor.execute(skillName, skillParams, message)
        return successResult(result)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        logger.error(`技能执行失败: ${skillName}`, error)
        return errorResult(`技能执行失败: ${errorMsg}`)
      }
    },
  }
}

/**
 * 列出可用技能的工具
 */
export function createListSkillsTool(registry: SkillRegistry): Tool {
  return {
    definition: {
      name: 'list_skills',
      description: '列出所有可用的技能',
      parameters: {},
      required: [],
      dangerous: false,
      readOnly: true,
    },

    async execute(): Promise<ToolResult> {
      const skills = registry.list()
      const output = skills
        .map(s => `- **${s.name}**: ${s.description || '无描述'}`)
        .join('\n')
      return successResult(output || '暂无可用技能')
    },
  }
}
```

---

## 3. Phase 2: 工具完善 (P1)

### 3.1 WebSearchTool

```typescript
// src/tools/web-search-tool.ts

import type { Tool, ToolResult } from './tool-interface'
import { successResult, errorResult } from './tool-interface'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

export const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description: '在网络上搜索信息',
    parameters: {
      query: {
        type: 'string',
        description: '搜索查询',
      },
      limit: {
        type: 'number',
        description: '结果数量限制，默认 5',
      },
    },
    required: ['query'],
    dangerous: false,
    readOnly: true,
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string
    const limit = (params.limit as number) || 5

    // 使用 DuckDuckGo 或其他搜索 API
    // 这里需要实现实际的搜索逻辑

    return successResult(`搜索结果: ${query}`)
  },
}
```

### 3.2 WebFetchTool

```typescript
// src/tools/web-fetch-tool.ts

import type { Tool, ToolResult } from './tool-interface'
import { successResult, errorResult } from './tool-interface'

export const webFetchTool: Tool = {
  definition: {
    name: 'web_fetch',
    description: '抓取网页内容',
    parameters: {
      url: {
        type: 'string',
        description: '网页 URL',
      },
      selector: {
        type: 'string',
        description: 'CSS 选择器（可选）',
      },
    },
    required: ['url'],
    dangerous: false,
    readOnly: true,
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const url = params.url as string
    const selector = params.selector as string | undefined

    // 使用 BrowserTool 或直接 HTTP 请求

    return successResult(`抓取: ${url}`)
  },
}
```

### 3.3 注册现有工具

```typescript
// src/tools/index.ts 更新

import { globTool } from './glob-tool'
import { grepTool } from './grep-tool'
import { webSearchTool } from './web-search-tool'
import { webFetchTool } from './web-fetch-tool'
import { browserTool } from './browser-tool'
import { createSkillTool, createListSkillsTool } from '../skills/skill-tool'

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  // 基础工具
  registry.register(bashTool)
  registry.registerAll(createFileTools())

  // 搜索工具
  registry.register(globTool)
  registry.register(grepTool)

  // 网络工具
  registry.register(webSearchTool)
  registry.register(webFetchTool)

  // 浏览器工具
  registry.register(browserTool)

  // Skill 工具
  registry.register(createSkillTool())
  registry.register(createListSkillsTool(getSkillRegistry()))

  return registry
}
```

---

## 4. Phase 3: 高级功能 (P2)

### 4.1 AgentTool 增强

```typescript
// src/agent/agent-tool.ts

/**
 * 子 Agent 调度工具
 * 允许创建独立的子 Agent 来处理特定任务
 */
export const agentTool: Tool = {
  definition: {
    name: 'agent',
    description: '创建子 Agent 执行特定任务',
    parameters: {
      task: {
        type: 'string',
        description: '任务描述',
      },
      model: {
        type: 'string',
        description: '使用的模型（可选）',
      },
      maxTurns: {
        type: 'number',
        description: '最大轮数',
      },
    },
    required: ['task'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    // 实现子 Agent 调度
    return successResult('Agent 任务完成')
  },
}
```

### 4.2 Task 异步系统

```typescript
// src/tasks/types.ts

export interface Task {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  result?: unknown
  error?: string
  createdAt: number
  updatedAt: number
}

// src/tasks/manager.ts

export class TaskManager {
  private tasks: Map<string, Task> = new Map()

  async create(name: string, handler: () => Promise<unknown>): Promise<string> {
    const id = generateId()
    const task: Task = {
      id,
      name,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.tasks.set(id, task)

    // 异步执行
    this.runTask(id, handler)

    return id
  }

  private async runTask(id: string, handler: () => Promise<unknown>): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return

    task.status = 'running'
    task.updatedAt = Date.now()

    try {
      const result = await handler()
      task.status = 'completed'
      task.result = result
      task.progress = 100
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error)
    }

    task.updatedAt = Date.now()
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  list(): Task[] {
    return Array.from(this.tasks.values())
  }
}
```

### 4.3 LSPTool

```typescript
// src/tools/lsp-tool.ts

/**
 * LSP 工具
 * 提供代码智能功能：跳转定义、查找引用、重命名等
 */
export const lspTool: Tool = {
  definition: {
    name: 'lsp',
    description: '语言服务器协议工具，提供代码智能功能',
    parameters: {
      action: {
        type: 'string',
        description: '操作类型: definition | references | rename | hover | completion',
      },
      file: {
        type: 'string',
        description: '文件路径',
      },
      line: {
        type: 'number',
        description: '行号',
      },
      column: {
        type: 'number',
        description: '列号',
      },
      newName: {
        type: 'string',
        description: '新名称（用于重命名）',
      },
    },
    required: ['action', 'file', 'line', 'column'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    // 需要集成 LSP 客户端
    // 可以使用 vscode-languageserver-protocol 包
    return successResult('LSP 操作完成')
  },
}
```

### 4.4 ScheduleCronTool

```typescript
// src/tools/schedule-tool.ts

import cron from 'node-cron'

export const scheduleCronTool: Tool = {
  definition: {
    name: 'schedule',
    description: '创建定时任务',
    parameters: {
      cron: {
        type: 'string',
        description: 'Cron 表达式',
      },
      command: {
        type: 'string',
        description: '要执行的命令或任务描述',
      },
      name: {
        type: 'string',
        description: '任务名称',
      },
    },
    required: ['cron', 'command'],
  },

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const cronExpr = params.cron as string
    const command = params.command as string
    const name = params.name as string

    if (!cron.validate(cronExpr)) {
      return errorResult('无效的 Cron 表达式')
    }

    const task = cron.schedule(cronExpr, () => {
      // 执行命令
      console.log(`执行定时任务: ${name || command}`)
    })

    return successResult(`定时任务已创建: ${name || cronExpr}`)
  },
}
```

---

## 5. 文件结构

```
src/
├── mcp/                      # MCP 系统 (新增)
│   ├── index.ts
│   ├── types.ts
│   ├── client.ts
│   ├── server-manager.ts
│   ├── tool-adapter.ts
│   └── transport/
│       ├── stdio.ts
│       └── websocket.ts
│
├── skills/                   # Skill 系统 (新增)
│   ├── index.ts
│   ├── types.ts
│   ├── loader.ts
│   ├── registry.ts
│   ├── executor.ts
│   ├── skill-tool.ts
│   └── builtins/
│       ├── code-review.md
│       ├── git-expert.md
│       └── translator.md
│
├── tasks/                    # 异步任务 (新增)
│   ├── index.ts
│   ├── types.ts
│   ├── manager.ts
│   └── tools.ts
│
├── tools/                    # 工具系统 (扩展)
│   ├── index.ts              # 更新导出
│   ├── tool-interface.ts
│   ├── tool-registry.ts
│   ├── bash-tool.ts
│   ├── file-tools.ts
│   ├── glob-tool.ts          # 新增
│   ├── grep-tool.ts          # 新增
│   ├── web-search-tool.ts    # 新增
│   ├── web-fetch-tool.ts     # 新增
│   ├── browser-tool.ts       # 新增（适配）
│   ├── lsp-tool.ts           # 新增
│   ├── agent-tool.ts         # 新增
│   └── schedule-tool.ts      # 新增
│
└── config/
    └── mcp-servers.json      # MCP 服务器配置
```

---

## 6. 实现优先级

### Phase 1 (P0) - 必须实现
1. MCP 客户端和服务器管理
2. MCP 工具适配器
3. Skill 加载器和注册表
4. Skill 执行器和工具

### Phase 2 (P1) - 重要
1. GlobTool / GrepTool 注册
2. WebSearchTool
3. WebFetchTool
4. BrowserTool 适配

### Phase 3 (P2) - 增强
1. AgentTool 增强
2. Task 异步系统
3. ~~LSPTool~~ (暂不实现)
4. ScheduleCronTool

> **注意**: LSPTool 暂不实现

---

## 7. 依赖

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "node-cron": "^4.2.1",
    "yaml": "^2.3.4"
  }
}
```

---

## 8. 配置文件

### 8.1 MCP 服务器配置
```json
// ~/.xdev/mcp-servers.json
{
  "servers": [
    {
      "name": "playwright",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-puppeteer"]
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/home/wxy/data"]
    }
  ]
}
```

### 8.2 内置 Skill 示例
```markdown
<!-- src/skills/builtins/code-review.md -->
---
name: code-review
description: 代码审查专家
parameters:
  - name: language
    description: 编程语言
    required: true
  - name: focus
    description: 关注点
    required: false
---

# 代码审查专家

你是一个专业的代码审查专家，专注于 {{language}} 代码审查。

{{#if focus}}
重点关注: {{focus}}
{{/if}}

## 审查清单
1. 代码风格和可读性
2. 潜在 bug 和边界情况
3. 性能问题
4. 安全漏洞
5. 测试覆盖
```
