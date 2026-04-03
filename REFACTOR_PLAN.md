# 小智系统改造计划（精简版）

> 基于对 Claude Code 源码（originClaw）、Python 重写（clawd-code）及互联网逆向分析的综合评估

---

## 一、设计原则

### 精简原则
- ❌ **移除** Worker 管理 → 用进程内 Agent 替代
- ❌ **移除** 定时任务 → 用系统 cron/systemd 替代
- ✅ **保留** 飞书交互、消息卡片
- ✅ **新增** SDK 直连、记忆系统、多 Agent 协作

### 改造目标
从「CLI 包装器」升级为「原生 AI Agent 平台」

---

## 二、开发分支策略

| 分支 | 用途 |
|------|------|
| `master` | 稳定版本 |
| `feature/sdk-rewrite` | Phase 1-2（SDK + 记忆 + Prompt） |
| `feature/multi-agent` | Phase 3-4（多 Agent + 权限） |

---

## 三、改造功能清单

### 🔴 P0 - 核心架构改造

#### 3.1 SDK 直连替换 CLI Spawn

**当前问题**：
- `spawn('claude')` 启动开销 500ms-2s
- CLI 不可编程，无法共享状态
- 无法实现进程内 Agent 协作

**改造方案**：

使用智谱提供的 **Claude API 兼容接口**，只需修改 `base_url` 和 `api_key`：

```typescript
// 当前
const proc = spawn('claude', ['--print', '--dangerously-skip-permissions', prompt])

// 改造后 - 使用 @anthropic-ai/sdk 连接智谱 GLM
import Anthropic from '@anthropic-ai/sdk'

// 智谱 GLM 配置
const GLM_CONFIG = {
  baseURL: 'https://open.bigmodel.cn/api/anthropic',
  apiKey: process.env.ZHIPU_API_KEY,
}

// 统一客户端
class LLMClient {
  private client: Anthropic

  constructor() {
    this.client = new Anthropic({
      apiKey: GLM_CONFIG.apiKey,
      baseURL: GLM_CONFIG.baseURL,
    })
  }

  async chat(params: ChatParams): Promise<AsyncIterable<ChatEvent>> {
    const stream = await this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: params.messages,
      tools: params.tools,
      system: params.system,
    })

    for await (const event of stream) {
      yield this.normalizeEvent(event)
    }
  }
}
```

**支持模型配置**：

```typescript
// 模型配置
interface ModelConfig {
  id: string
  name: string
  provider: 'glm'
  contextWindow: number
  maxOutput: number
  costPerMtok: { input: number; output: number }
}

const AVAILABLE_MODELS: ModelConfig[] = [
  // 智谱 GLM 模型（GLM-5 系列）
  {
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'glm',
    contextWindow: 200_000,        // 200K 上下文
    maxOutput: 128_000,            // 128K 输出
    costPerMtok: { input: 1, output: 1 },  // 编程计划价格
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'glm',
    contextWindow: 200_000,        // 200K 上下文
    maxOutput: 128_000,            // 128K 输出
    costPerMtok: { input: 1, output: 1 },  // 龙虾增强基座，任务专项优化
  },
]

// 模型选择
class ModelSelector {
  private defaultModel: string

  constructor() {
    // 从配置读取默认模型
    this.defaultModel = process.env.XIAOZHI_MODEL || 'glm-5'  // 默认使用 GLM-5
  }

  getModel(id?: string): ModelConfig {
    const modelId = id || this.defaultModel
    const model = AVAILABLE_MODELS.find(m => m.id === modelId)
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`)
    }
    return model
  }

  listModels(): ModelConfig[] {
    return AVAILABLE_MODELS
  }
}
```

**使用示例**：

```typescript
// 初始化客户端
const llmClient = new LLMClient('glm')

// 流式对话
const stream = await llmClient.chat({
  model: 'glm-5',
  maxTokens: 16000,
  messages: [{ role: 'user', content: '你好' }],
  tools: toolDefinitions,
  system: systemPrompt,
})

for await (const event of stream) {
  if (event.type === 'content_delta') {
    process.stdout.write(event.text)
  }
  if (event.type === 'tool_use') {
    const result = await executeTool(event.toolName, event.toolInput)
    // 继续对话...
  }
}
```

**涉及文件**：
- `xiaozhi/src/core/llm-client.ts` - 新增，统一 LLM 客户端
- `xiaozhi/src/core/model-config.ts` - 新增，模型配置
- `xiaozhi/src/core/model-selector.ts` - 新增，模型选择器
- `xiaozhi/src/core/message-history.ts` - 新增，消息历史管理
- `xiaozhi/src/core/claude-native-agent.ts` - 删除

**收益**：
- 启动延迟：500-2000ms → 50-100ms
- 支持 streaming 输出
- 可共享消息历史
- 支持工具调用
- **完全移除 Claude CLI 依赖**

---

#### 3.1.1 动态模型能力管理

**借鉴 originClaw 的模型管理系统**，让小智可以自主选择和切换模型。

**设计目标**：
- 动态获取模型能力（上下文窗口、输出限制等）
- 基于任务复杂度自动选择合适模型
- 支持模型别名系统（简短名称 → 完整模型 ID）
- GLM-5 特殊能力支持（thinking mode、function calling）

```typescript
// src/core/model-capabilities.ts

interface ModelCapability {
  id: string
  name: string
  provider: 'glm'

  // 上下文限制
  contextWindow: number      // 最大输入 tokens
  maxOutput: number           // 最大输出 tokens

  // 能力标志
  supportsThinking: boolean   // 支持 thinking mode
  supportsVision: boolean     // 支持图像输入
  supportsTools: boolean      // 支持工具调用
  maxToolCalls: number        // 单次最大工具调用数

  // 成本
  costPerMtok: {
    input: number
    output: number
    cacheWrite?: number
    cacheRead?: number
  }

  // 别名
  aliases: string[]            // 如 ['glm5', 'g5'] -> 'glm-5'
}

// 默认能力配置（当 API 不可用时回退）
const DEFAULT_CAPABILITIES: ModelCapability[] = [
  {
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'glm',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    maxToolCalls: 700,
    costPerMtok: { input: 1, output: 1 },
    aliases: ['glm5', 'g5', 'glm-5'],
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'glm',
    contextWindow: 200_000,
    maxOutput: 128_000,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    maxToolCalls: 700,
    costPerMtok: { input: 1, output: 1 },
    aliases: ['turbo', 'g5t', 'glm-5-turbo'],
  },
]

// 能力缓存路径
const CAPABILITIES_CACHE_PATH = path.join(
  os.homedir(),
  '.claude',
  'cache',
  'model-capabilities.json'
)

class ModelCapabilitiesManager {
  private capabilities: Map<string, ModelCapability> = new Map()
  private aliasMap: Map<string, string> = new Map()
  private lastFetch: Date | null = null
  private cacheTTL: number = 24 * 60 * 60 * 1000  // 24小时

  constructor() {
    this.loadFromCache()
  }

  /**
   * 从缓存加载能力配置
   */
  private async loadFromCache(): Promise<void> {
    try {
      const cacheContent = await fs.readFile(CAPABILITIES_CACHE_PATH, 'utf-8')
      const cached = JSON.parse(cacheContent)
      this.lastFetch = new Date(cached.timestamp)

      // 检查缓存是否过期
      if (Date.now() - this.lastFetch.getTime() < this.cacheTTL) {
        for (const cap of cached.capabilities) {
          this.capabilities.set(cap.id, cap)
          for (const alias of cap.aliases) {
            this.aliasMap.set(alias.toLowerCase(), cap.id)
          }
        }
        logger.info(`从缓存加载 ${this.capabilities.size} 个模型能力`)
      }
    } catch {
      // 缓存不存在或无效，使用默认配置
      this.loadDefaults()
    }
  }

  /**
   * 加载默认配置
   */
  private loadDefaults(): void {
    for (const cap of DEFAULT_CAPABILITIES) {
      this.capabilities.set(cap.id, cap)
      for (const alias of cap.aliases) {
        this.aliasMap.set(alias.toLowerCase(), cap.id)
      }
    }
    logger.info('使用默认模型能力配置')
  }

  /**
   * 从 API 刷新能力配置
   * 借鉴 originClaw/src/utils/model/modelCapabilities.ts
   */
  async refreshFromAPI(): Promise<void> {
    // GLM API 可能没有能力查询接口，暂时跳过
    // 未来可以定期从文档或配置文件更新
    logger.info('GLM API 暂不支持能力查询，使用内置配置')
  }

  /**
   * 解析模型名称（支持别名）
   */
  resolveModel(input: string): ModelCapability {
    // 先尝试完整 ID
    let capability = this.capabilities.get(input)
    if (capability) return capability

    // 尝试别名
    const canonicalId = this.aliasMap.get(input.toLowerCase())
    if (canonicalId) {
      capability = this.capabilities.get(canonicalId)
      if (capability) return capability
    }

    // 模糊匹配
    const fuzzyMatch = this.fuzzyMatch(input)
    if (fuzzyMatch) return fuzzyMatch

    throw new Error(`Unknown model: ${input}. Available: ${[...this.capabilities.keys()].join(', ')}`)
  }

  /**
   * 模糊匹配模型名称
   */
  private fuzzyMatch(input: string): ModelCapability | null {
    const lower = input.toLowerCase()

    // glm-5 -> glm-5
    if (lower.includes('glm') && lower.includes('5')) {
      if (lower.includes('turbo')) {
        return this.capabilities.get('glm-5-turbo')
      }
      return this.capabilities.get('glm-5')
    }

    return null
  }
}
```

**智能模型选择**：

```typescript
// src/core/model-selector.ts

interface TaskComplexity {
  level: 'simple' | 'moderate' | 'complex' | 'research'
  estimatedTokens: number
  requiresVision: boolean
  requiresThinking: boolean
  toolCallCount: number
}

class IntelligentModelSelector {
  private capabilities: ModelCapabilitiesManager

  constructor(capabilities: ModelCapabilitiesManager) {
    this.capabilities = capabilities
  }

  /**
   * 分析任务复杂度
   */
  analyzeTaskComplexity(
    message: string,
    tools: Tool[] = [],
    attachments: Attachment[] = []
  ): TaskComplexity {
    const text = message.toLowerCase()

    // 简单任务：短消息，无需工具
    const isSimple = message.length < 200 &&
      !tools.some(t => t.requiresExecution) &&
      !text.includes('分析') &&
      !text.includes('设计') &&
      !text.includes('重构')

    if (isSimple) {
      return {
        level: 'simple',
        estimatedTokens: 500,
        requiresVision: false,
        requiresThinking: false,
        toolCallCount: 0,
      }
    }

    // 研究任务：需要深度分析
    const isResearch =
      text.includes('研究') ||
      text.includes('分析') ||
      text.includes('调研') ||
      text.includes('探索') ||
      text.includes('深度')

    if (isResearch) {
      return {
        level: 'research',
        estimatedTokens: 10000,
        requiresVision: attachments.some(a => a.type === 'image'),
        requiresThinking: true,
        toolCallCount: 20,
      }
    }

    // 复杂任务：多步骤、需要思考
    const isComplex =
      text.includes('重构') ||
      text.includes('设计') ||
      text.includes('实现') ||
      text.includes('开发') ||
      tools.length > 5

    if (isComplex) {
      return {
        level: 'complex',
        estimatedTokens: 5000,
        requiresVision: attachments.some(a => a.type === 'image'),
        requiresThinking: true,
        toolCallCount: 10,
      }
    }

    // 中等任务
    return {
      level: 'moderate',
      estimatedTokens: 2000,
      requiresVision: attachments.some(a => a.type === 'image'),
      requiresThinking: false,
      toolCallCount: 3,
    }
  }

  /**
   * 选择最佳模型
   */
  selectBestModel(
    complexity: TaskComplexity,
    preference?: {
      model?: string
    }
  ): ModelCapability {
    // 如果用户指定了模型，优先使用
    if (preference?.model) {
      return this.capabilities.resolveModel(preference.model)
    }

    const candidates = this.capabilities.listAll()

    // 根据复杂度筛选
    const suitable = candidates.filter(cap => {
      // 上下文窗口检查
      if (cap.contextWindow < complexity.estimatedTokens) return false

      // 视觉能力检查
      if (complexity.requiresVision && !cap.supportsVision) return false

      // 工具调用数检查
      if (complexity.toolCallCount > cap.maxToolCalls) return false

      return true
    })

    if (suitable.length === 0) {
      // 没有合适的，使用默认
      return this.capabilities.resolveModel('glm-5')
    }

    // 按成本效益排序
    suitable.sort((a, b) => {
      // 简单任务优先低成本
      if (complexity.level === 'simple') {
        return a.costPerMtok.input - b.costPerMtok.input
      }

      // 复杂任务优先能力（thinking mode）
      if (complexity.level === 'complex' || complexity.level === 'research') {
        if (a.supportsThinking && !b.supportsThinking) return -1
        if (!a.supportsThinking && b.supportsThinking) return 1
      }

      // 同等能力下选择低成本
      return a.costPerMtok.input - b.costPerMtok.input
    })

    return suitable[0]
  }
}
```

**GLM-5 特殊能力支持**：

```typescript
// src/core/glm-extensions.ts

/**
 * GLM-5 特殊参数
 */
interface GLMSpecialParams {
  // Thinking Mode - 启用深度思考
  enable_thinking?: boolean

  // 工具调用配置
  tool_choice?: {
    type: 'auto' | 'any' | 'none'
    disable_parallel_tool_calls?: boolean
  }
}

/**
 * 构建带 thinking mode 的请求
 */
function buildGLMRequest(
  baseParams: ChatParams,
  capability: ModelCapability,
  taskComplexity: TaskComplexity
): ChatParams & GLMSpecialParams {
  const params: ChatParams & GLMSpecialParams = { ...baseParams }

  // 复杂任务启用 thinking mode
  if (capability.supportsThinking &&
      (taskComplexity.level === 'complex' || taskComplexity.level === 'research')) {
    params.enable_thinking = true
    logger.info('启用 GLM-5 thinking mode 用于复杂任务')
  }

  return params
}

/**
 * 解析 thinking mode 输出
 * GLM-5 thinking mode 会在响应中包含 <think reasoning>...</think reasoning> 块
 */
function parseThinkingOutput(content: string): {
  thinking: string | null
  response: string
} {
  const thinkMatch = content.match(/<think reasoning>([\s\S]*?)<\/think reasoning>/)
  if (thinkMatch) {
    return {
      thinking: thinkMatch[1].trim(),
      response: content.replace(/<think reasoning>[\s\S]*?<\/think reasoning>/, '').trim(),
    }
  }
  return {
    thinking: null,
    response: content,
  }
}
```

**涉及文件**：
- `xiaozhi/src/core/model-capabilities.ts` - 新增，模型能力管理
- `xiaozhi/src/core/model-selector.ts` - 增强，智能模型选择
- `xiaozhi/src/core/glm-extensions.ts` - 新增，GLM-5 特殊能力支持

**收益**：
- 小智可根据任务复杂度自动选择合适模型
- 支持模型别名（如 `turbo` → `glm-5-turbo`）
- 支持 GLM-5 thinking mode 用于复杂任务
- 降低成本（简单任务用低成本模型）

---

#### 3.2 记忆系统

**设计原则**：用户只管说话，小智负责记住。让用户无感知，自动完成短期、长期记忆的提取和归类。

**当前问题**：
- 每次会话从零开始
- 无法记住用户偏好、项目约定、历史决策
- 无自动记忆提取机制

##### 3.2.1 记忆类型（三分法）

借鉴 LangMem 和人类记忆系统：

| 类型 | 说明 | 示例 |
|------|------|------|
| **语义记忆** | 事实、偏好、知识 | "用户喜欢简洁回复"、"项目使用 TypeScript" |
| **情景记忆** | 事件、对话片段 | "4月1日修复了登录bug"、"用户提到要优化性能" |
| **程序记忆** | 技能、流程、最佳实践 | "测试命令是 npm test"、"代码规范是..." |

##### 3.2.2 记忆作用域

| 作用域 | 说明 | 存储位置 |
|--------|------|----------|
| **私有** | 仅当前用户 | `~/.xiaozhi/memory/` |
| **项目** | 特定项目上下文 | `~/.xiaozhi/memory/projects/<project>/` |
| **团队** | 多 Agent 协作时共享 | `~/.xiaozhi/teams/<team-id>/memory/` |

##### 3.2.3 目录结构

```
~/.xiaozhi/memory/
├── MEMORY.md                    # 主索引（200行/25KB限制）
├── semantic/                    # 语义记忆
│   ├── preferences.md           # 用户偏好
│   ├── facts.md                 # 事实信息
│   └── conventions/             # 项目约定
│       └── xiaozhi.md
├── episodic/                    # 情景记忆
│   ├── 2026-04-01-login-fix.md  # 按事件存储
│   └── 2026-04-02-performance.md
├── procedural/                  # 程序记忆
│   └── workflows.md             # 工作流程
└── sessions/                    # 会话记忆
    ├── session-xxx-summary.md   # 会话摘要
    └── session-yyy-summary.md
```

##### 3.2.4 记忆提取机制

借鉴 originClaw 的后台 subagent 提取方式：

```typescript
// 触发条件
interface ExtractionTrigger {
  tokenThreshold: number;        // Token 阈值（默认 8000）
  toolCallThreshold: number;     // 工具调用次数（默认 10）
  timeInterval: number;          // 时间间隔（默认 5 分钟）
  onSessionEnd: boolean;         // 会话结束时提取
  onTopicChange: boolean;        // 主题切换时提取
}

// 提取流程
async function extractMemories(session: SessionMemory): Promise<void> {
  // 1. 检测触发条件
  if (!shouldExtract(session)) return;

  // 2. 启动后台 subagent 进行提取
  const memories = await runExtractionAgent(session);

  // 3. 去重并保存
  for (const memory of memories) {
    if (!isDuplicate(memory)) {
      await saveMemory(memory);
    }
  }

  // 4. 更新 MEMORY.md 索引
  await updateMemoryIndex();
}
```

**提取 Prompt 模板**（借鉴 originClaw）：

```typescript
const EXTRACTION_PROMPT = `
# 记忆提取专家

你负责从对话中提取有价值的长期记忆。

## 提取类型
1. **用户偏好** (user_preference): 用户的个人偏好和习惯
2. **项目约定** (project_convention): 项目的技术栈、规范、约定
3. **决策记录** (decision): 重要的技术或业务决策
4. **反馈** (feedback): 用户的反馈、评价、纠正

## 提取规则
- 只提取有长期价值的信息
- 忽略临时性、一次性的内容
- 合并相似的记忆
- 标注重要性（1-10）

## 输出格式
JSON 数组，每个元素包含：
- type: 记忆类型
- content: 记忆内容
- importance: 重要性评分
- tags: 相关标签
`;
```

##### 3.2.5 记忆检索

借鉴 originClaw 的 LLM 相关性检索：

```typescript
// LLM 相关性检索
async function retrieveRelevantMemories(
  query: string,
  options: RetrievalOptions
): Promise<MemoryEntry[]> {
  // 1. 快速关键词过滤
  const candidates = await keywordFilter(query);

  // 2. LLM 相关性评分
  const relevant = await llmSelectRelevant(query, candidates, {
    maxCount: 5,
    minRelevance: 0.7,
  });

  // 3. 按新鲜度 + 相关性排序
  return sortByRelevanceAndFreshness(relevant);
}
```

##### 3.2.6 多 Agent 团队记忆

当小智使用 Agent tool 创建多个 subagent 协作时，需要团队记忆机制：

```
~/.xiaozhi/teams/<team-id>/
├── config.json              # 团队配置
├── state.json               # 团队状态
├── memory/                  # 团队共享记忆
│   ├── TEAM_MEMORY.md       # 团队记忆索引
│   ├── discoveries.md       # 发现和洞察
│   └── decisions.md         # 团队决策
└── messages/                # 团队消息历史
    ├── researcher.jsonl
    ├── coder.jsonl
    └── reviewer.jsonl
```

**团队记忆特点**：
1. **共享发现**：每个 agent 发现的有价值信息自动同步
2. **避免重复**：agent 之间共享已探索的信息
3. **协作决策**：重要决策需要多个 agent 确认
4. **结果汇总**：任务完成后自动生成团队总结

```typescript
// 团队记忆管理
class TeamMemoryManager {
  // agent 发现新信息时调用
  async shareDiscovery(agentId: string, discovery: string): Promise<void> {
    const teamMemory = await this.loadTeamMemory();
    teamMemory.discoveries.push({
      agentId,
      discovery,
      timestamp: Date.now(),
    });
    await this.saveTeamMemory(teamMemory);

    // 通知其他 agent
    await this.broadcastToTeam({
      type: 'discovery',
      from: agentId,
      content: discovery,
    });
  }

  // agent 做出决策时调用
  async recordDecision(agentId: string, decision: Decision): Promise<void> {
    const teamMemory = await this.loadTeamMemory();
    teamMemory.decisions.push({
      ...decision,
      agentId,
      timestamp: Date.now(),
    });
    await this.saveTeamMemory(teamMemory);
  }

  // 新 agent 加入时获取上下文
  async getTeamContext(): Promise<string> {
    const teamMemory = await this.loadTeamMemory();
    return this.buildContextSummary(teamMemory);
  }
}
```

##### 3.2.7 会话记忆模板

每段会话结束后，生成结构化摘要：

```markdown
# 会话摘要 - 2026-04-02

## 主题
优化小智记忆系统

## 关键决策
- 采用三分法记忆类型（语义/情景/程序）
- 使用后台 subagent 进行记忆提取
- 实现 LLM 相关性检索

## 执行操作
- 创建 `src/memory/types.ts` 定义记忆类型
- 重构 `src/memory/memory-manager.ts`
- 添加团队记忆支持

## 提取的记忆
- [preference] 用户喜欢简洁直接的回复风格
- [convention] 项目使用 TypeScript + ES Modules
- [decision] 选择借鉴 originClaw 的后台提取方式

## Token 统计
- 输入: 12,345 tokens
- 输出: 8,765 tokens
- 总计: 21,110 tokens
```

##### 3.2.8 记忆注入 Prompt

```typescript
// 构建记忆注入片段
async function buildMemoryPrompt(query: string): Promise<string> {
  // 1. 检索相关记忆
  const memories = await retrieveRelevantMemories(query, { limit: 15 });

  if (memories.length === 0) return '';

  // 2. 按类型分组
  const grouped = groupByType(memories);

  // 3. 构建提示词
  const lines = ['## 长期记忆', ''];

  if (grouped.semantic.length > 0) {
    lines.push('### 用户偏好与知识');
    for (const m of grouped.semantic) {
      lines.push(`- ${m.content}`);
    }
    lines.push('');
  }

  if (grouped.episodic.length > 0) {
    lines.push('### 相关事件');
    for (const m of grouped.episodic) {
      lines.push(`- ${m.content}`);
    }
    lines.push('');
  }

  if (grouped.procedural.length > 0) {
    lines.push('### 工作流程');
    for (const m of grouped.procedural) {
      lines.push(`- ${m.content}`);
    }
  }

  return lines.join('\n');
}
```

##### 3.2.9 涉及文件

| 文件 | 说明 |
|------|------|
| `src/memory/types.ts` | 记忆类型定义 |
| `src/memory/memory-manager.ts` | 记忆管理器 |
| `src/memory/memory-extractor.ts` | 后台提取 subagent |
| `src/memory/memory-retriever.ts` | LLM 相关性检索 |
| `src/memory/team-memory.ts` | 团队记忆管理 |
| `src/memory/session-memory.ts` | 会话记忆模板 |

##### 3.2.10 收益

- **用户无感**：自动提取，无需手动命令
- **跨会话积累**：长期记忆持久化
- **智能检索**：LLM 相关性匹配，精准注入
- **团队协作**：多 Agent 共享发现和决策
- **自动归类**：按类型、主题自动分类存储

---

#### 3.3 Prompt 系统重构

**当前问题**：
- 260 行单体字符串，难以维护
- 无缓存优化
- 缺乏输出效率和工具使用指南

**改造方案**：
```typescript
// 模块化 Prompt 结构
const STATIC_SECTIONS = [
  { name: 'identity', content: getIdentitySection, cacheable: true },
  { name: 'system', content: getSystemSection, cacheable: true },
  { name: 'doing_tasks', content: getDoingTasksSection, cacheable: true },
  { name: 'actions', content: getActionsSection, cacheable: true },
  { name: 'tools', content: getToolsSection, cacheable: true },
  { name: 'output', content: getOutputSection, cacheable: true },
]

const DYNAMIC_SECTIONS = [
  { name: 'memory', content: loadMemoryPrompt, cacheable: false },
  { name: 'env', content: getEnvInfo, cacheable: false },
  { name: 'git', content: getGitStatus, cacheable: false },
  { name: 'date', content: getCurrentDate, cacheable: false },
]

async function buildSystemPrompt(): Promise<string[]> {
  const sections: string[] = []

  // 静态内容（可缓存）
  for (const section of STATIC_SECTIONS) {
    sections.push(await section.content())
  }

  // 动态边界
  sections.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  // 动态内容
  for (const section of DYNAMIC_SECTIONS) {
    sections.push(await section.content())
  }

  return sections
}
```

**Prompt 段落设计**：

| 段落 | 内容 | 缓存 |
|------|------|------|
| Identity | 身份定义、权限说明 | ✅ |
| System | 系统级行为规范 | ✅ |
| Doing Tasks | 任务执行指南 | ✅ |
| Actions | 风险操作指南 | ✅ |
| Tools | 工具使用指南 | ✅ |
| Output | 输出效率（简洁、≤25词） | ✅ |
| Memory | 记忆注入 | ❌ |
| Env | 环境信息 | ❌ |
| Git | Git 状态 | ❌ |

**关键指南（借鉴 originClaw）**：

```typescript
// 输出效率指南
const OUTPUT_SECTION = `
# Output efficiency
Go straight to the point. Keep text output brief and direct.
Lead with the answer or action, not the reasoning.
Focus on: decisions, milestones, errors.
If you can say it in one sentence, don't use three.
Keep text between tool calls to ≤25 words.
`

// 工具使用指南
const TOOLS_SECTION = `
# Using your tools
- Do NOT use Bash when a dedicated tool is provided
- To read files use Read instead of cat/head/tail
- To edit files use Edit instead of sed/awk
- Call multiple tools in parallel when independent
`

// 风险操作指南
const ACTIONS_SECTION = `
# Executing actions with care
For risky actions, check first:
- Destructive: rm -rf, delete branches
- Hard-to-reverse: force-push, reset --hard
- Visible to others: push code, send messages
`
```

**涉及文件**：
- `xiaozhi/src/prompt/builder.ts` - 新增
- `xiaozhi/src/prompt/sections/*.ts` - 新增
- `xiaozhi/src/prompt/context.ts` - 新增

---

### 🟠 P1 - 效率提升

#### 3.4 进程内多 Agent 协作

**当前问题**：
- Worker 通过 spawn 独立进程，开销大
- 进程间通信依赖 HTTP/文件

**改造方案**：
```typescript
// 替代 Worker 的进程内 Agent
interface TeamConfig {
  name: string
  members: TeamMember[]
}

interface TeamMember {
  name: string           // 'researcher', 'coder', 'reviewer'
  type: AgentType        // 'general-purpose' | 'explore' | 'plan'
  tools: string[]        // 可用工具列表
}

class TeamManager {
  private members: Map<string, InProcessAgent>
  private messageBus: MessageBus

  async createTeam(config: TeamConfig): Promise<void> {
    for (const member of config.members) {
      this.members.set(member.name, new InProcessAgent(member))
    }
  }

  async sendMessage(to: string, message: string): Promise<void> {
    const agent = this.members.get(to)
    if (agent) {
      await agent.receiveMessage(message)
    }
  }
}

// 使用示例
const team = new TeamManager()
await team.createTeam({
  name: 'code-review',
  members: [
    { name: 'researcher', type: 'explore', tools: ['Glob', 'Grep', 'Read'] },
    { name: 'coder', type: 'general-purpose', tools: ['Read', 'Edit', 'Write', 'Bash'] },
    { name: 'reviewer', type: 'plan', tools: ['Read', 'Grep'] },
  ]
})

await team.sendMessage('researcher', '分析 src/core 模块')
```

**涉及文件**：
- `xiaozhi/src/agent/team-manager.ts` - 新增
- `xiaozhi/src/agent/message-bus.ts` - 新增
- `xiaozhi/src/agent/in-process-agent.ts` - 新增

**收益**：
- 通信延迟：100-500ms → <1ms
- 共享消息历史和记忆
- 内存占用更低

---

#### 3.5 工具系统标准化

**改造方案**：
```typescript
interface Tool {
  name: string
  description: string
  inputSchema: ZodSchema

  call(input: unknown, context: ToolContext): Promise<ToolResult>
  checkPermission(input: unknown, context: ToolContext): Promise<PermissionResult>

  isReadOnly(): boolean
  isDestructive(): boolean
  isConcurrencySafe(): boolean
}

// 工具实现示例
const FileReadTool: Tool = {
  name: 'Read',
  description: '读取文件内容',
  inputSchema: z.object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),

  async call(input, context) {
    const content = await fs.readFile(input.file_path, 'utf-8')
    return { success: true, content }
  },

  async checkPermission(input, context) {
    // 检查路径是否在允许范围内
    return { allowed: true }
  },

  isReadOnly: () => true,
  isDestructive: () => false,
  isConcurrencySafe: () => true,
}
```

**涉及文件**：
- `xiaozhi/src/tools/tool-interface.ts` - 新增
- `xiaozhi/src/tools/tool-registry.ts` - 新增
- `xiaozhi/src/tools/read-tool.ts` - 新增
- `xiaozhi/src/tools/edit-tool.ts` - 新增
- `xiaozhi/src/tools/write-tool.ts` - 新增
- `xiaozhi/src/tools/bash-tool.ts` - 新增
- `xiaozhi/src/tools/glob-tool.ts` - 新增
- `xiaozhi/src/tools/grep-tool.ts` - 新增

---

#### 3.6 上下文压缩（与记忆系统联动）

**设计原则**：压缩前先提取记忆，重要信息不丢失。

**触发条件**：
- Token 使用率达到 92% 阈值
- API 返回 `prompt_too_long` 错误时自动触发
- 用户手动执行 `/compact` 命令

**联动流程**：
```
检测上下文接近限制 (92%)
    ↓
1. 记忆提取（MemoryExtractor）
   - 从待压缩消息中提取重要信息
   - 保存到长期记忆（MEMORY.md）
    ↓
2. 压缩历史（ContextCompressor）
   - 保留：用户消息、错误信息、关键决策
   - 摘要：工具调用结果、冗长输出
   - 删除：重复内容、临时信息
    ↓
3. 注入记忆（MemoryRetriever）
   - 检索相关记忆
   - 注入到新上下文开头
    ↓
4. 继续对话
```

**代码设计**：
```typescript
interface CompressionConfig {
  threshold: 0.92           // 触发阈值
  targetRatio: 6.8          // 目标压缩比
  preserveUserMessages: true // 保留所有用户消息
  preserveErrors: true       // 保留错误信息
}

interface CompressionResult {
  compressedMessages: Message[]
  extractedMemories: MemoryEntry[]
  tokensBefore: number
  tokensAfter: number
  compressionRatio: number
}

class ContextCompressor {
  constructor(
    private memoryExtractor: MemoryExtractor,
    private memoryRetriever: MemoryRetriever
  ) {}

  async compact(messages: Message[]): Promise<CompressionResult> {
    // 1. 从旧消息提取记忆
    const memories = await this.memoryExtractor.extractFromMessages(messages)

    // 2. 压缩历史
    const compressed = await this.compressMessages(messages)

    // 3. 检索相关记忆注入
    const relevantMemories = await this.memoryRetriever.retrieve({
      query: this.getLastTopic(messages),
      limit: 10
    })

    // 4. 返回结果
    return {
      compressedMessages: this.injectMemories(compressed, relevantMemories),
      extractedMemories: memories,
      tokensBefore: this.countTokens(messages),
      tokensAfter: this.countTokens(compressed),
      compressionRatio: ...
    }
  }
}
```

**消息重要性评分**：
```typescript
function scoreMessageImportance(message: Message): number {
  let score = 0

  // 用户消息：高优先级
  if (message.role === 'user') score += 10

  // 包含错误：保留
  if (message.content.includes('错误') || message.content.includes('失败')) score += 8

  // 决策相关：保留
  if (message.content.includes('决定') || message.content.includes('选择')) score += 7

  // 工具结果：可压缩
  if (message.role === 'tool_result') score += 3

  // 最近的消息：加权
  score += recencyBonus(message.timestamp)

  return score
}
```

**压缩提示词模板**：
```typescript
const COMPACT_PROMPT = `# 对话压缩任务

请将以下对话历史压缩为简洁的摘要。

## 保留内容
1. 用户的原始请求和目标
2. 关键决策和选择
3. 重要发现和结论
4. 未完成的任务

## 可省略内容
1. 详细的工具调用过程
2. 重复的确认信息
3. 错误修复的中间步骤（保留最终解决方案）

## 输出格式
使用 Markdown 格式输出摘要，控制在 500 tokens 以内。`
```

**涉及文件**：
- `src/context/compressor.ts` - 压缩器核心
- `src/context/prompt.ts` - 压缩提示词
- `src/core/message-history.ts` - 添加压缩触发检测

**收益**：
- 6-8x 上下文压缩比
- 重要信息自动进入长期记忆
- 支持超长对话（无限延续）
- 压缩后仍保留关键上下文

---

### 🟡 P2 - 增强功能

#### 3.7 Git Worktree 隔离

**场景**：子 Agent 在隔离环境中执行任务

```typescript
interface WorktreeConfig {
  name: string
  baseBranch: string
}

async function enterWorktree(config: WorktreeConfig): Promise<WorktreeSession>
async function exitWorktree(session: WorktreeSession, action: 'keep' | 'remove'): Promise<void>
```

**涉及文件**：
- `xiaozhi/src/tools/enter-worktree-tool.ts` - 新增
- `xiaozhi/src/tools/exit-worktree-tool.ts` - 新增

---

#### 3.8 错误处理增强

**当前问题**：
- 错误处理简单，无分类
- 无自动重试机制
- 无降级策略

**改造方案**：
```typescript
// 错误分类
enum APIErrorType {
  PROMPT_TOO_LONG = 'prompt_too_long',      // 自动压缩后重试
  RATE_LIMIT = 'rate_limit',                 // 延迟后重试
  SERVER_OVERLOADED = 'server_overloaded',   // 降级到次级模型
  CONNECTION_TIMEOUT = 'connection_timeout', // 重连
  AUTH_ERROR = 'auth_error',                 // 需要用户干预
}

interface APIErrorHandler {
  type: APIErrorType
  retryable: boolean
  maxRetries: number
  action: 'retry' | 'fallback' | 'compact' | 'abort'
}

async function handleAPIError(error: APIError): Promise<void> {
  switch (error.type) {
    case 'prompt_too_long':
      // 解析 token 超出数量
      const { actualTokens, limitTokens } = parsePromptTooLong(error.message)
      // 自动压缩历史
      await compactHistory()
      // 自动重试
      return retry()

    case 'server_overloaded':
      if (consecutive529Errors >= 3) {
        // 降级 Opus → Sonnet（通知用户）
        notifyUser('服务器繁忙，临时切换到 Sonnet 模型')
        return fallbackToSonnet()
      }
      return retry({ delay: 2000, maxRetries: 5 })

    case 'rate_limit':
      return retry({ delay: 60000, maxRetries: 3 })

    case 'connection_timeout':
      return reconnect()
  }
}
```

**涉及文件**：
- `xiaozhi/src/core/error-handler.ts` - 新增
- `xiaozhi/src/core/retry.ts` - 新增

**收益**：
- 减少用户干预
- 提升稳定性
- 自动恢复

---

#### 3.9 语言偏好

**当前问题**：
- 偶尔输出英文
- 无强制语言控制

**改造方案**：
```typescript
// Prompt 中注入语言偏好
function getLanguageSection(language: string = '中文'): string {
  return `# Language
Always respond in ${language}. Use ${language} for all explanations,
comments, and communications with the user. Technical terms and code
identifiers should remain in their original form.`
}

// 配置
interface XiaozhiConfig {
  language: '中文' | 'English' | '日本語'  // 默认中文
}
```

**涉及文件**：
- `xiaozhi/src/config.ts` - 添加 language 配置
- `xiaozhi/src/prompt/sections/language.ts` - 新增

**收益**：
- 强制中文输出
- 体验一致性

---

#### 3.10 会话恢复

**当前问题**：
- 断线后会话丢失
- 无法从中断处恢复

**改造方案**：
```typescript
// 会话持久化
interface PersistedSession {
  sessionId: string
  messages: Message[]
  context: {
    cwd: string
    gitBranch: string
    memoryFile: string
  }
  createdAt: Date
  updatedAt: Date
}

// 自动保存（每轮对话后）
async function saveSession(session: PersistedSession): Promise<void> {
  await fs.writeFile(
    `~/.xiaozhi/sessions/${session.sessionId}.json`,
    JSON.stringify(session)
  )
}

// 恢复会话
async function restoreSession(sessionId: string): Promise<PersistedSession | null> {
  const file = `~/.xiaozhi/sessions/${sessionId}.json`
  if (await fs.exists(file)) {
    return JSON.parse(await fs.readFile(file, 'utf-8'))
  }
  return null
}

// 启动时检查未完成会话
async function checkUnfinishedSession(): Promise<void> {
  const lastSession = await getLastSession()
  if (lastSession && !lastSession.completed) {
    // 询问用户是否恢复
    const shouldResume = await askUser('检测到未完成的会话，是否恢复？')
    if (shouldResume) {
      await restoreSession(lastSession.sessionId)
    }
  }
}
```

**涉及文件**：
- `xiaozhi/src/session/persistence.ts` - 新增
- `xiaozhi/src/session/restore.ts` - 新增

**收益**：
- 断线恢复
- 不丢失上下文

---

#### 3.11 成本追踪增强

**当前问题**：
- Token 统计基础
- 无成本计算

**改造方案**：
```typescript
// 模型成本配置
const MODEL_COSTS = {
  'glm-5': {
    inputTokens: 1,       // ¥1/MTok（智谱编程计划）
    outputTokens: 1,      // ¥1/MTok
  },
  'glm-5-turbo': {
    inputTokens: 1,       // ¥1/MTok
    outputTokens: 1,      // ¥1/MTok
  },
}

// 成本计算
interface UsageStats {
  inputTokens: number
  outputTokens: number
  totalCost: number       // 人民币
}

function calculateCost(usage: Usage, model: string): number {
  const costs = MODEL_COSTS[model] || MODEL_COSTS['glm-5']
  return (
    (usage.inputTokens / 1_000_000) * costs.inputTokens +
    (usage.outputTokens / 1_000_000) * costs.outputTokens
  )
}

// 会话级成本汇总
interface SessionCost {
  totalCost: number
  byModel: Record<string, number>
  turns: number
  avgCostPerTurn: number
}
```

**涉及文件**：
- `xiaozhi/src/telemetry/cost-tracker.ts` - 增强
- `xiaozhi/src/telemetry/model-costs.ts` - 新增

**收益**：
- 精确成本统计
- 支持多模型计费

---

### 🟢 P3 - 可选功能

#### 3.12 Output Styles（输出样式）

**场景**：支持不同的输出风格

```typescript
type OutputStyle = 'default' | 'explanatory' | 'learning'

const OUTPUT_STYLE_PROMPTS = {
  default: null,  // 简洁模式

  explanatory: `
## Insights
提供教育性洞察：
\`★ Insight ─────────────────────────────────────\`
[2-3 个关键教育点]
\`─────────────────────────────────────────────────\`
`,

  learning: `
## Learn by Doing
要求用户贡献 2-10 行代码，让用户动手学习：
**Context:** [背景]
**Your Task:** [具体任务]
**Guidance:** [指导]
`
}
```

**涉及文件**：
- `xiaozhi/src/prompt/sections/output-style.ts` - 新增

---

#### 3.13 会话自动命名

**场景**：自动生成有意义的会话名称

```typescript
async function generateSessionName(messages: Message[]): Promise<string> {
  const text = extractConversationText(messages)

  // 使用小模型生成名称
  const result = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system: 'Generate a short kebab-case name (2-4 words) in Chinese pinyin.',
    messages: [{ role: 'user', content: text }]
  })

  return result.content  // "fix-login-bug", "add-auth-feature"
}
```

**涉及文件**：
- `xiaozhi/src/session/naming.ts` - 新增

---

#### 3.14 图片/PDF 处理

**场景**：支持多模态附件

```typescript
// 图片处理
interface ImageAttachment {
  type: 'image'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string  // base64
}

// 图片大小限制
const MAX_IMAGE_SIZE = 20 * 1024 * 1024  // 20MB
const TARGET_IMAGE_SIZE = 2 * 1024 * 1024  // 压缩目标 2MB

// PDF 处理
const PDF_MAX_PAGES = 100

async function processImage(filePath: string): Promise<ImageAttachment> {
  let buffer = await fs.readFile(filePath)

  // 超过限制则压缩
  if (buffer.length > MAX_IMAGE_SIZE) {
    buffer = await resizeImage(buffer, TARGET_IMAGE_SIZE)
  }

  return {
    type: 'image',
    media_type: detectMimeType(filePath),
    data: buffer.toString('base64')
  }
}
```

**涉及文件**：
- `xiaozhi/src/attachments/image-processor.ts` - 新增
- `xiaozhi/src/attachments/pdf-processor.ts` - 新增

---

#### 3.8 权限系统增强

**改造方案**（6 层安全门）：
```
1. UI 层 - 用户可见性控制
2. Router 层 - 路由策略
3. Tool 层 - 工具级别权限
4. Param 层 - 参数校验
5. OS 层 - 沙箱隔离（bubblewrap/Seatbelt）
6. Output 层 - 输出过滤
```

**涉及文件**：
- `xiaozhi/src/permissions/permission-checker.ts` - 重构
- `xiaozhi/src/permissions/sandbox.ts` - 新增

---

#### 3.9 遥测与监控

**改造方案**：
```typescript
// OpenTelemetry 集成
const tracer = opentelemetry.trace.getTracer('xiaozhi')

span = tracer.startSpan('tool_execution', {
  attributes: { tool_name: 'BashTool', duration_ms: 150 }
})
```

**涉及文件**：
- `xiaozhi/src/telemetry/tracer.ts` - 新增
- `xiaozhi/src/telemetry/cost-tracker.ts` - 新增

---

## 四、实施计划

### Phase 1：SDK 直连 + Prompt 重构（分支：`feature/sdk-rewrite`）
**时间**：2-3 周

| 任务 | 优先级 | 状态 |
|------|--------|------|
| 实现 GLM SDK 调用 | P0 | ✅ 已完成 |
| 实现模型能力管理 | P0 | ✅ 已完成 |
| 实现智能模型选择 | P1 | ✅ 已完成 |
| 实现消息历史管理 | P0 | ✅ 已完成 |
| 重构 Prompt 系统为模块化结构 | P0 | ✅ 已完成 |
| 实现动态上下文注入（Git、环境） | P1 | ✅ 已完成 |
| 实现语言偏好控制 | P1 | ✅ 已完成 |
| 实现基础工具（Read/Edit/Write/Bash/Glob/Grep） | P0 | ✅ 已完成 |
| 实现错误分类和自动重试 | P1 | ✅ 已完成 |
| 保持飞书集成兼容 | P0 | ✅ 已完成 |

### Phase 2：记忆系统 + 会话（分支：`feature/sdk-rewrite`）
**时间**：1-2 周

| 任务 | 优先级 | 状态 |
|------|--------|------|
| 实现 MEMORY.md 读写 | P0 | ✅ 已完成 |
| 实现相关性搜索 | P1 | ✅ 已完成 |
| 实现自动记忆触发 | P1 | ✅ 已完成 |
| ~~实现会话持久化~~ | ~~P1~~ | ❌ 已移除（不需要） |
| ~~实现会话恢复~~ | ~~P1~~ | ❌ 已移除（不需要） |
| 测试并合并到 master | P0 | 待开始 |

**关于会话管理的决策**：

由于用户通过飞书与小智对话（单一通道），且记忆系统自动跨会话积累知识，传统的会话管理变得不必要：

- ❌ 不需要多会话切换（飞书只有一个对话）
- ❌ 不需要会话恢复（长期记忆系统自动保留重要信息）
- ✅ 内存中的消息历史足够应对当前对话
- ✅ 重启后：内存历史清空，但长期记忆保留

架构简化为：
```
飞书消息 → 内存消息历史 → LLM → 回复
    ↓
重要信息 → 自动提取 → 长期记忆（MEMORY.md）
```

### Phase 3：多 Agent 协作（分支:`feature/multi-agent`）
**时间**：2 周

| 任务 | 优先级 | 状态 |
|------|--------|------|
| 实现 InProcessAgent | P1 | ✅ 已完成 |
| 实现消息传递系统 | P1 | ✅ 已完成 |
| 实现团队管理 | P1 | ✅ 已完成 |
| 实现 Worktree 隔离 | P2 | ✅ 已完成 |

### Phase 4：权限与监控（分支：`feature/multi-agent`）
**时间**：1 周

| 任务 | 优先级 | 状态 |
|------|--------|------|
| 实现多层权限检查 | P2 | ✅ 已完成 |
| 实现 OpenTelemetry 遥测 | P2 | ✅ 已完成 |
| 实现成本追踪增强 | P2 | ✅ 已完成 |
| 实现上下文压缩 | P1 | ✅ 已完成 |

### Phase 5：可选功能（按需实现）
**时间**：1 周

| 任务 | 优先级 | 状态 |
|------|--------|------|
| 实现 Output Styles | P3 | ✅ 已完成 |
| 实现会话自动命名 | P3 | ✅ 已完成 |
| 实现图片/PDF 处理 | P3 | ✅ 已完成 |

---

## 五、代码结构

### 改造后目录结构

```
xiaozhi/src/
├── core/
│   ├── sdk-agent.ts           # SDK 直连核心
│   ├── message-history.ts     # 消息历史管理
│   ├── error-handler.ts       # 错误处理
│   └── retry.ts               # 重试逻辑
│
├── memory/
│   ├── memory-manager.ts      # 记忆管理
│   └── relevance-search.ts    # 相关性搜索
│
├── prompt/
│   ├── builder.ts             # Prompt 构建器
│   ├── context.ts             # 上下文注入
│   └── sections/              # 模块化段落
│       ├── identity.ts
│       ├── system.ts
│       ├── doing-tasks.ts
│       ├── actions.ts
│       ├── tools.ts
│       ├── output.ts
│       ├── language.ts        # 语言偏好
│       └── output-style.ts    # 输出样式
│
├── agent/
│   ├── team-manager.ts        # 团队管理
│   ├── message-bus.ts         # 消息传递
│   └── in-process-agent.ts    # 进程内 Agent
│
├── tools/
│   ├── tool-interface.ts      # Tool 接口
│   ├── tool-registry.ts       # 工具注册表
│   ├── read-tool.ts
│   ├── edit-tool.ts
│   ├── write-tool.ts
│   ├── bash-tool.ts
│   ├── glob-tool.ts
│   ├── grep-tool.ts
│   ├── enter-worktree-tool.ts
│   └── exit-worktree-tool.ts
│
├── session/
│   ├── persistence.ts         # 会话持久化
│   ├── restore.ts             # 会话恢复
│   └── naming.ts              # 会话命名（P3）
│
├── context/
│   └── compressor.ts          # 上下文压缩
│
├── permissions/
│   ├── permission-checker.ts  # 权限检查
│   └── sandbox.ts             # 沙箱隔离
│
├── telemetry/
│   ├── tracer.ts              # OpenTelemetry
│   ├── cost-tracker.ts        # 成本追踪
│   └── model-costs.ts         # 模型成本配置
│
├── attachments/               # P3 可选
│   ├── image-processor.ts     # 图片处理
│   └── pdf-processor.ts       # PDF 处理
│
├── feishu/
│   ├── client.ts              # 飞书客户端（保留）
│   └── card-builder.ts        # 消息卡片（保留）
│
└── index.ts                   # 入口
```

### 删除的文件/目录

```
xiaozhi/src/
├── core/claude-native-agent.ts    # 删除（CLI spawn）
├── expert/                         # 删除整个目录（专家系统）
├── worker/                         # 删除整个目录（Worker 管理）
└── cron/                           # 删除整个目录（定时任务）
```

---

## 六、功能对比

| 功能 | 改造前 | 改造后 | 优先级 |
|------|:------:|:------:|:------:|
| **保留** ||||
| 飞书交互 | ✅ | ✅ | - |
| 消息卡片 | ✅ | ✅ | - |
| **移除** ||||
| Worker 管理 | ✅ | ❌ | - |
| 定时任务 | ✅ | ❌ | - |
| Claude CLI 依赖 | ✅ | ❌ | - |
| ~/.claude/ 配置目录 | ✅ | ❌ | - |
| **核心改造（P0-P1）** ||||
| SDK 直连 | ❌ | ✅ | P0 |
| 动态模型能力管理 | ❌ | ✅ | P0 |
| 智能模型选择 | ❌ | ✅ | P1 |
| 持久记忆 | ❌ | ✅ | P0 |
| 进程内多 Agent | ❌ | ✅ | P1 |
| 工具标准化 | ❌ | ✅ | P1 |
| 模块化 Prompt | ❌ | ✅ | P0 |
| 错误处理增强 | ❌ | ✅ | P1 |
| 语言偏好 | ❌ | ✅ | P1 |
| 会话恢复 | ❌ | ✅ | P1 |
| **增强功能（P2）** ||||
| 上下文压缩 | ❌ | ✅ | P1 |
| Git Worktree | ❌ | ✅ | P2 |
| 权限分层 | ❌ | ✅ | P2 |
| 成本追踪增强 | ❌ | ✅ | P2 |
| OpenTelemetry | ❌ | ✅ | P2 |
| **可选功能（P3）** ||||
| Output Styles | ❌ | ✅ | P3 |
| 会话自动命名 | ❌ | ✅ | P3 |
| 图片/PDF 处理 | ❌ | ✅ | P3 |

---

## 七、性能指标预估

| 指标 | 改造前 | 改造后 | 提升 |
|------|--------|--------|------|
| 首次响应延迟 | 1-2s | 50-100ms | **10-20x** |
| Agent 通信延迟 | 100-500ms | <1ms | **100-500x** |
| 上下文容量 | ~128K | ~800K（压缩后） | **6x** |
| 记忆持久性 | 0 | ∞ | ∞ |
| 并行 Agent | 1（串行） | 5+（并行） | **5x+** |

---

## 八、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| SDK 稳定性 | 中 | 完善错误处理 + 自动重试 |
| 上下文爆炸 | 高 | 实现压缩系统 + Prompt Too Long 自动触发 |
| 飞书集成兼容 | 中 | 保持现有接口 |
| 权限绕过 | 高 | 多层校验 |
| 会话丢失 | 中 | 自动持久化 + 恢复机制 |
| 成本超支 | 中 | 成本追踪 + 预算告警 |
| 错误处理不完善 | 中 | 分类错误 + 自动重试 + 降级策略 |
| 配置迁移失败 | 低 | 保留旧配置，提供迁移脚本 |

---

## 九、参考资源

- [dev.to - 逆向工程 12 版本 Claude Code](https://dev.to/kolkov/we-reverse-engineered-12-versions-of-claude-code-then-it-leaked-its-own-source-code-pij)
- [gm7.org - Claude Code 源码泄露分析](https://www.gm7.org/archives/65388)
- `~/data/originClaw/PROJECT_ANALYSIS.md` - 完整架构分析
- `~/data/clawd-code/` - Python 重写参考

---

## 十、配置目录迁移

### 10.1 废弃 ~/.claude/ 目录

**当前问题**：
- 小智依赖 Claude CLI 的配置目录 `~/.claude/`
- 该目录包含 Claude CLI 的会话、设置、记忆等
- 移除 CLI 依赖后，这些配置将无效

**改造方案**：

小智使用独立的配置目录 `~/.xiaozhi/`，与 Claude CLI 完全解耦：

```
~/.xiaozhi/
├── config.json                  # 小智主配置文件
│
├── sessions/                    # 会话持久化
│   ├── current.json             # 当前会话
│   └── archive/                 # 归档会话
│       └── session-2026-04-01-*.json
│
├── memory/                      # 记忆系统
│   ├── MEMORY.md                # 记忆入口（200行/25KB限制）
│   ├── preferences.md           # 用户偏好
│   └── decisions.md             # 历史决策
│
├── teams/                       # 多 Agent 团队配置（替代 workers/）
│   └── team-xxx/
│       ├── config.json          # 团队配置
│       ├── state.json           # 团队状态
│       └── messages/            # 团队消息历史
│
├── cache/                       # 缓存目录
│   ├── model-capabilities.json  # 模型能力缓存（24小时TTL）
│   ├── tools.json               # 工具注册表缓存
│   └── prompts/                 # Prompt 模块缓存
│       ├── identity.hash        # 身份段落哈希
│       ├── system.hash          # 系统段落哈希
│       └── tools.hash           # 工具段落哈希
│
├── workspace/                   # 独立工作目录
│   ├── CLAUDE.md                # 系统提示词（动态生成）
│   └── temp/                    # 临时文件
│
└── logs/                        # 日志
    ├── xiaozhi.log              # 主日志
    └── error.log                # 错误日志
```

**目录说明**：

| 目录 | 用途 | 是否必需 |
|------|------|---------|
| `config.json` | 主配置文件 | ✅ |
| `sessions/` | 会话持久化，支持断线恢复 | ✅ |
| `memory/` | 跨会话记忆系统 | ✅ |
| `teams/` | 多 Agent 协作（替代 workers/） | 可选 |
| `cache/` | 模型能力、工具、Prompt 缓存 | ✅ |
| `workspace/` | 独立工作目录 | ✅ |
| `logs/` | 日志记录 | ✅ |

**已移除的目录**：

| 旧目录 | 原因 |
|--------|------|
| `workers/` | 移除 Worker 管理，用进程内 Agent 替代 |
| `cron/` | 移除定时任务，用系统 cron/systemd 替代 |
| `experts/` | 移除专家系统，用动态模型选择替代 |

**配置迁移**：

```typescript
// src/config.ts

export const PATHS = {
  // 小智配置目录
  XIAOZHI_HOME: path.join(os.homedir(), '.xiaozhi'),
  CONFIG_FILE: path.join(os.homedir(), '.xiaozhi', 'config.json'),

  // 子目录
  SESSIONS_DIR: path.join(os.homedir(), '.xiaozhi', 'sessions'),
  MEMORY_DIR: path.join(os.homedir(), '.xiaozhi', 'memory'),
  TEAMS_DIR: path.join(os.homedir(), '.xiaozhi', 'teams'),      // 多 Agent 团队
  CACHE_DIR: path.join(os.homedir(), '.xiaozhi', 'cache'),
  LOGS_DIR: path.join(os.homedir(), '.xiaozhi', 'logs'),

  // 工作目录
  WORKSPACE: path.join(os.homedir(), '.xiaozhi', 'workspace'),

  // 缓存文件
  MODEL_CAPABILITIES_CACHE: path.join(os.homedir(), '.xiaozhi', 'cache', 'model-capabilities.json'),
  TOOLS_CACHE: path.join(os.homedir(), '.xiaozhi', 'cache', 'tools.json'),
  PROMPTS_CACHE: path.join(os.homedir(), '.xiaozhi', 'cache', 'prompts'),
}

// 默认配置
export const DEFAULT_CONFIG: XiaozhiConfig = {
  // 模型配置
  model: {
    default: 'glm-5',
    allowAutoSwitch: true,        // 允许自动切换模型
    complexityThresholds: {
      simple: 500,                // < 500 tokens 视为简单
      moderate: 2000,             // < 2000 tokens 视为中等
      complex: 10000,             // < 10000 tokens 视为复杂
    },
  },

  // 权限配置
  permissions: {
    mode: 'default',              // 'default' | 'acceptEdits' | 'bypassPermissions'
    autoApprove: ['read', 'glob', 'grep', 'webfetch'],
    requireConfirm: ['bash', 'write', 'edit'],
  },

  // 记忆系统
  memory: {
    enabled: true,
    maxEntries: 100,
    maxFileSize: 25 * 1024,      // 25KB
    relevanceThreshold: 0.5,      // 相关性阈值
  },

  // 会话配置
  session: {
    autoSave: true,
    maxHistory: 1000,
    autoCompact: true,            // 自动压缩
    compactThreshold: 0.92,       // 92% 上下文窗口使用率触发压缩
  },

  // 多 Agent 配置
  agents: {
    maxParallel: 5,               // 最大并行 Agent 数
    defaultTimeout: 120000,        // 默认超时 2 分钟
    enableWorktree: true,          // 启用 Worktree 隔离
  },

  // 语言偏好
  language: '中文',

  // 遥测
  telemetry: {
    enabled: true,
    trackCosts: true,
    logLevel: 'info',
  },
}
```

**迁移脚本**：

```typescript
// scripts/migrate-config.ts

/**
 * 从 ~/.claude/ 迁移配置到 ~/.xiaozhi/
 * 注意：只迁移记忆文件，不迁移会话（格式不兼容）
 */
async function migrateFromClaudeCLI(): Promise<void> {
  const oldDir = path.join(os.homedir(), '.claude')
  const newDir = PATHS.XIAOZHI_HOME

  // 检查是否需要迁移
  if (!fs.existsSync(oldDir)) {
    console.log('未找到 ~/.claude/ 目录，跳过迁移')
    return
  }

  // 创建新目录结构
  const dirs = [
    PATHS.SESSIONS_DIR,
    PATHS.MEMORY_DIR,
    PATHS.TEAMS_DIR,
    PATHS.CACHE_DIR,
    PATHS.LOGS_DIR,
    PATHS.WORKSPACE,
    path.join(PATHS.CACHE_DIR, 'prompts'),
    path.join(PATHS.SESSIONS_DIR, 'archive'),
  ]

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }

  // 迁移 MEMORY.md
  const oldMemory = path.join(oldDir, 'MEMORY.md')
  const newMemory = path.join(PATHS.MEMORY_DIR, 'MEMORY.md')
  if (fs.existsSync(oldMemory) && !fs.existsSync(newMemory)) {
    await fs.copy(oldMemory, newMemory)
    console.log('✅ 已迁移 MEMORY.md')
  }

  // 初始化默认配置
  const configFile = PATHS.CONFIG_FILE
  if (!fs.existsSync(configFile)) {
    await fs.writeJson(configFile, DEFAULT_CONFIG, { spaces: 2 })
    console.log('✅ 已创建默认配置文件')
  }

  // 初始化 CLAUDE.md（工作目录的系统提示词）
  const claudeMd = path.join(PATHS.WORKSPACE, 'CLAUDE.md')
  if (!fs.existsSync(claudeMd)) {
    await fs.writeFile(claudeMd, `# 小智工作目录\n\n此文件由系统动态生成。\n`)
    console.log('✅ 已初始化工作目录')
  }

  console.log('\n配置迁移完成！')
  console.log('注意：~/.claude/ 目录已保留，可继续用于 Claude CLI')
}

/**
 * 初始化小智目录结构
 */
async function initXiaozhiHome(): Promise<void> {
  const xiaozhiHome = PATHS.XIAOZHI_HOME

  if (fs.existsSync(xiaozhiHome)) {
    console.log('~/.xiaozhi/ 目录已存在')
    return
  }

  // 创建完整目录结构
  await migrateFromClaudeCLI()
}
```

**涉及文件**：
- `xiaozhi/src/config.ts` - 重构，使用新路径
- `xiaozhi/scripts/migrate-config.ts` - 新增，迁移脚本

**收益**：
- 完全独立于 Claude CLI
- 配置结构更清晰
- 可以与小智独立演进
- 支持从旧配置平滑迁移

---

### 10.2 移除的依赖

以下依赖将被移除：

| 依赖 | 原因 |
|------|------|
| `claude` CLI | 使用 SDK 直连 |
| `~/.claude/` 配置 | 使用独立配置目录 |
| Claude 会话文件 | 使用新的会话管理 |

**注意**：`~/.claude/` 目录可以保留，用于独立安装的 Claude CLI。小智将不再依赖它。
