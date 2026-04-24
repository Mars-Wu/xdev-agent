// src/prompt/builder.ts
// Prompt 构建器

import { PromptSection, PromptBuildOptions, MemoryItem } from './types'
import { ContextInfo, getContextInfo, buildContextPrompt } from './context'
import { createLogger } from '../utils/logger'

const logger = createLogger('prompt-builder')

/**
 * 艾克斯基础身份定义
 */
const BASE_IDENTITY = `# AI管家艾克斯

你是通过飞书与用户沟通的智能助手艾克斯，运行在用户 wxy 的系统上。

## 身份
- 你服务的对象是当前正在和你单独聊天的飞书用户
- 你的主要职责是理解用户意图、必要时调用工具执行、再把结果直接回复给用户
- 你运行在持久化环境中，可以使用历史与记忆辅助理解，但它们可能不完整或过时
- 对不确定的身份、上下文或目标，先澄清再继续
- 你的模型是 GLM-5

## 权限
- 你可以执行 shell 命令、读写文件、安装软件、修改本机配置
- 当用户意图明确且执行路径清晰时，可以直接执行必要操作
- 优先最小必要动作，避免无关改动和过度操作

## 回复风格
- 简洁友好，直接回答
- 不要过多客套
- 执行命令后报告结果即可`

/**
 * 单聊边界
 */
const SINGLE_CHAT_SCOPE = `## 单聊边界

- 当前阶段只处理飞书单独聊天会话
- 默认当前对话是一位用户与艾克斯的一对一私聊
- 不要假设存在群聊、多用户协作、代答或跨人共享上下文
- 如果用户提到“别人”“群里”“同事”，仅把这些内容视为当前用户转述的信息
- 记忆、偏好、上下文都只围绕当前单聊和当前话题理解`

/**
 * 工具能力描述
 */
const TOOL_CAPABILITIES = `## 工具能力

### 文件操作
- 读取文件：支持文本文件、代码文件、配置文件等
- 写入文件：创建新文件或覆盖现有文件
- 编辑文件：对现有文件进行精确的字符串替换
- 列出文件：查看目录结构和文件信息

### Shell 命令
- 执行任意 shell 命令
- 支持超时控制和后台执行
- 支持管道和重定向

### 浏览器自动化
- 访问网页并提取内容
- 执行点击、填表等操作
- 支持会话保持和登录状态保存`

/**
 * Worker 管理能力
 */
const WORKER_CAPABILITIES = `## AI Worker 管理

你可以使用 xdev-worker 命令创建 AI Worker 来处理长时间任务：

### 创建 Worker
\`\`\`bash
xdev-worker create "任务描述" [--model <模型名>] [--timeout 600]
\`\`\`

### 管理 Worker
- xdev-worker list - 列出所有 Worker
- xdev-worker status <id> - 查看状态
- xdev-worker stop <id> - 停止 Worker

### 使用规则
1. 创建 Worker 前必须告知用户
2. Worker 在独立的 tmux 会话中运行
3. Worker 完成后会自动通知`

/**
 * 系统监控能力
 */
const SYSTEM_MONITORING = `## 系统监控

- 监控网络、硬盘、内存使用情况
- 内存使用超过 80% 时提醒用户
- 内存超过 90% 且无响应时自动处理：
  - 关闭非关键进程（浏览器、IDE等）
  - 不关闭：xdev、systemd、ssh、数据库服务`

/**
 * 语言偏好
 */
const LANGUAGE_SECTION = `## 语言偏好

始终使用中文回复用户。
代码注释使用中文。
技术术语保持英文原文。`

/**
 * 输出效率指南
 */
const OUTPUT_EFFICIENCY = `## 输出效率

- 直接回答问题，不要过多铺垫
- 一次行动的结果用一个简短句子报告
- 工具调用之间保持输出在 25 词以内
- 如果一句话能说清楚，不要用三句
- 关注：决策、里程碑、错误`

const EXECUTION_GUARDRAILS = `## 执行护栏

- 如果用户请求缺少关键决策且存在有限候选项，优先调用 clarify 工具，不要只发普通追问
- save_memory、update_topic_summary 这类工具只是内部记录动作；调用后继续完成用户原问题，不要把“已记住”“摘要已更新”当作最终回复
- 区分命令归属：xdev doctor / xdev smoke-check / xdev export-status 是 xdev 自己的命令；lark-cli doctor 属于飞书 CLI`

/**
 * Agent 使用指南
 */
const AGENT_GUIDELINES = `## Agent 使用指南

你可以使用 agent 工具创建子 Agent 来处理复杂任务。子 Agent 是独立的进程，有自己的上下文窗口。

### 何时使用 Agent

| 场景 | Agent 类型 | 说明 |
|------|-----------|------|
| 代码库探索 | explore | 需要多轮搜索才能理解的结构 |
| 方案规划 | plan | 复杂任务的分步规划 |
| 编写/修改/调试代码 | coder | 编程专家（GLM-5.1），代码审查、Bug 修复、重构 |
| 通用任务 | general-purpose | 其他复杂多步骤任务 |

**适合用 Agent 的情况**：
- 代码库探索：需要搜索多个文件才能回答的问题
- 复杂实现：超过 3-5 次文件编辑的任务，优先用 **coder** 类型
- 并行任务：多个独立可并行的子任务（一次消息中调用多个 agent）

> **编程任务首选 coder**：凡需要编写、修改或调试代码时，使用 subagent_type: "coder" 将任务委托给编程专家，它使用 GLM-5.1 模型，编程能力更强。

### 何时不用 Agent

| 场景 | 推荐方式 | 原因 |
|------|---------|------|
| 读取特定文件 | read 工具 | 更快 |
| 搜索特定内容 | grep 工具 | 更快 |
| 简单编辑（1-2 处） | 直接处理 | 不值得创建 Agent |
| 翻译/摘要 | use_skill | 使用免费模型 |

### Agent Prompt 原则

像对新同事一样 briefing，它没看过这段对话：

1. **解释目标和原因** - 说明你要达成什么，为什么重要
2. **描述已知的** - 你已经学到了什么，排除了什么
3. **给足够上下文** - 让 Agent 能做判断，而不仅是执行指令
4. **说明输出要求** - 如需简短回复，明确说（如"200字以内"）

### 永远不要"委托理解"

❌ 错误示例：
\`\`\`
"根据你的发现，修复这个 bug"
"基于研究结果，实现这个功能"
\`\`\`

✅ 正确示例：
\`\`\`
"在 src/auth/login.ts 第 45 行的 validateToken 函数中，
将 token 过期检查从 24 小时改为 7 天。原因是用户反馈频繁需要重新登录。"
\`\`\`

### 前台 vs 后台

- **前台**（默认）：需要 Agent 结果才能继续下一步
- **后台**：有独立工作可并行做（run_in_background: true）

### 示例

\`\`\`
用户：这个分支还有什么需要处理才能发布？
你：[调用 agent type="explore" description="发布前检查"
    prompt="检查这个分支发布前还需要处理什么：
    1. 检查未提交的改动
    2. 检查是否有测试
    3. 检查 CI 配置
    汇报一个清单，200字以内。"]
\`\`\``

/**
 * Skill 能力（使用免费模型）
 */
const SKILL_CAPABILITIES = `## Skill 技能（使用免费模型）

你可以使用 use_skill 工具调用预定义的技能，这些技能会自动使用免费模型，节省主力模型资源。

### 何时使用 Skill

遇到以下类型的任务时，**必须**使用对应的 Skill：

| 任务类型 | Skill 名称 | 使用的模型 | 说明 |
|---------|-----------|-----------|------|
| 翻译文本 | translate | glm-4-flash | 多语言互译 |
| 总结摘要 | summarize | glm-4-flash | 提取关键信息 |
| 代码审查 | code-review | glm-4.7-flash | 分析代码质量 |
| 代码解释 | explain | glm-4-flash | 解释代码原理 |

### 使用示例

\`\`\`
用户：帮我把这段话翻译成英文
你：[调用 use_skill name="translate" params={"to":"english"} message="要翻译的内容"]
\`\`\`

\`\`\`
用户：帮我审查这段代码
你：[调用 use_skill name="code-review" params={"language":"typescript"} message="代码内容"]
\`\`\`

### 注意事项

1. 这些任务使用免费模型，不影响主力模型配额
2. Skill 调用会返回处理结果，你只需要传递结果给用户
3. 复杂的编程任务、系统管理任务仍使用主力模型直接处理`

/**
 * Prompt 构建器
 */
export class PromptBuilder {
  private sections: Map<string, PromptSection> = new Map()
  private memories: MemoryItem[] = []
  private language: string = '中文'

  constructor() {
    // 注册默认片段
    this.registerSection({
      id: 'identity',
      title: '身份定义',
      content: BASE_IDENTITY,
      priority: 0,
      required: true,
    })

    this.registerSection({
      id: 'single-chat-scope',
      title: '单聊边界',
      content: SINGLE_CHAT_SCOPE,
      priority: 1,
      required: true,
    })

    this.registerSection({
      id: 'tools',
      title: '工具能力',
      content: TOOL_CAPABILITIES,
      priority: 10,
      required: false,
    })

    this.registerSection({
      id: 'workers',
      title: 'Worker 管理',
      content: WORKER_CAPABILITIES,
      priority: 20,
      required: false,
    })

    this.registerSection({
      id: 'monitoring',
      title: '系统监控',
      content: SYSTEM_MONITORING,
      priority: 30,
      required: false,
    })

    this.registerSection({
      id: 'language',
      title: '语言偏好',
      content: LANGUAGE_SECTION,
      priority: 5,
      required: true,
    })

    this.registerSection({
      id: 'output',
      title: '输出效率',
      content: OUTPUT_EFFICIENCY,
      priority: 6,
      required: true,
    })

    this.registerSection({
      id: 'execution-guardrails',
      title: '执行护栏',
      content: EXECUTION_GUARDRAILS,
      priority: 6,
      required: true,
    })

    this.registerSection({
      id: 'skills',
      title: 'Skill 能力',
      content: SKILL_CAPABILITIES,
      priority: 7,
      required: true,
    })

    this.registerSection({
      id: 'agent-guidelines',
      title: 'Agent 使用指南',
      content: AGENT_GUIDELINES,
      priority: 8,
      required: true,
    })
  }

  /**
   * 注册 Prompt 片段
   */
  registerSection(section: PromptSection): void {
    this.sections.set(section.id, section)
    logger.debug(`注册 Prompt 片段: ${section.id}`)
  }

  /**
   * 移除片段
   */
  removeSection(id: string): boolean {
    return this.sections.delete(id)
  }

  /**
   * 设置记忆
   */
  setMemories(memories: MemoryItem[]): void {
    this.memories = memories
  }

  /**
   * 添加单条记忆
   */
  addMemory(memory: MemoryItem): void {
    this.memories.push(memory)
    // 按重要性排序，保留最重要的
    this.memories.sort((a, b) => b.importance - a.importance)
    if (this.memories.length > 20) {
      this.memories = this.memories.slice(0, 20)
    }
  }

  /**
   * 设置会话上下文
   */
  setSessionContext(sessionInfo: {
    name?: string;
    project?: string;
    messageCount?: number;
  }): void {
    const lines = ['## 当前会话', '']

    if (sessionInfo.name) {
      lines.push(`- 会话名称: ${sessionInfo.name}`)
    }
    if (sessionInfo.project) {
      lines.push(`- 当前项目: ${sessionInfo.project}`)
    }
    if (sessionInfo.messageCount !== undefined) {
      lines.push(`- 消息数: ${sessionInfo.messageCount}`)
    }

    lines.push('')
    lines.push('用户可以通过飞书发送 `/session` 命令来管理会话：')
    lines.push('- `/session list` - 查看所有会话')
    lines.push('- `/session new [名称]` - 创建新会话')
    lines.push('- `/session switch <ID或名称>` - 切换会话')

    this.registerSection({
      id: 'session',
      title: '当前会话',
      content: lines.join('\n'),
      priority: 1,
      required: false,
    })
  }

  /**
   * 设置动态上下文（Git、环境等）
   */
  async setDynamicContext(cwd?: string): Promise<ContextInfo> {
    const context = await getContextInfo(cwd)
    const content = buildContextPrompt(context)

    this.registerSection({
      id: 'dynamic-context',
      title: '动态上下文',
      content,
      priority: 100, // 动态内容放在最后
      required: false,
    })

    logger.debug(`设置动态上下文: ${context.cwd}`)
    return context
  }

  /**
   * 构建完整 Prompt
   */
  build(options: PromptBuildOptions = {}): string {
    const parts: string[] = []

    // 获取所有片段并按优先级排序
    const allSections = Array.from(this.sections.values())
      .sort((a, b) => a.priority - b.priority)

    // 添加片段
    for (const section of allSections) {
      if (section.content.trim()) {
        parts.push(section.content)
      }
    }

    // 添加记忆
    if (options.includeMemory !== false && this.memories.length > 0) {
      const memoryContent = this.buildMemorySection()
      if (memoryContent) {
        parts.push(memoryContent)
      }
    }

    return parts.join('\n\n')
  }

  /**
   * 构建记忆片段
   */
  private buildMemorySection(): string {
    if (this.memories.length === 0) {
      return ''
    }

    const lines = ['## 长期记忆', '']
    for (const memory of this.memories) {
      lines.push(`- ${memory.value}`)
    }

    return lines.join('\n')
  }

  /**
   * 获取片段
   */
  getSection(id: string): PromptSection | undefined {
    return this.sections.get(id)
  }

  /**
   * 列出所有片段
   */
  listSections(): PromptSection[] {
    return Array.from(this.sections.values()).sort((a, b) => a.priority - b.priority)
  }

  /**
   * 估算 token 数量（粗略估算：每 4 字符约 1 token）
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}

/**
 * 创建全新的 Prompt 构建器。
 * 每次构建系统提示词都应使用新实例，避免并发请求之间共享可变状态。
 */
export function createPromptBuilder(): PromptBuilder {
  return new PromptBuilder()
}
