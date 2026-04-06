// src/core/message-router.ts
// Stage 1：消息路由器 + Context 组装器
//
// 职责：
//   1. 用 glm-5-turbo（轻量快速）在干净上下文中分类消息，决定属于哪个话题
//   2. 按路由结果从话题 history bucket 加载适量上下文
//   3. 组装完整 { systemPrompt, messages } 供 Stage 2 使用
//
// 关键设计：路由判断在污染上下文之外进行，避免循环依赖

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { LLMClient } from './llm-client'
import type { MemoryManager } from '../memory/memory-manager'
import { MessageHistoryManager, type Message } from './message-history'
import { TopicGraph, type TopicSummary } from '../storage/topic-graph'
import { configManager } from '../config'

const logger = createLogger('message-router')

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type HistoryStrategy = 'full' | 'recent_20' | 'summary_only' | 'none'

export interface RouteResult {
  topicId: string
  isNewTopic: boolean
  subMessage: string         // 从原消息提炼的独立子问题（自含上下文）
  historyStrategy: HistoryStrategy
  historyHint: string        // LLM 自述选择原因，供调试
  relatedTopicIds: string[]
  entityTags: string[]
  confidence: number         // 0~1
}

// 路由器输出容器（单话题时 routes.length=1）
export interface MultiRouteResult {
  routes: RouteResult[]
  isMultiTopic: boolean
  splitHint: string
}

export interface AssembledContext {
  systemPrompt: string
  messages: Message[]        // topic history（已按 historyStrategy 筛选）
  topicId: string
  subMessage: string         // 对应话题的子问题（单话题时等于原始消息）
  topicHistory: MessageHistoryManager  // 完整 bucket（供 Stage 2 追加新消息）
  route: RouteResult
  isFallback: boolean        // true = 路由失败，使用降级空 context
}

// ── 路由器 system prompt（固定，可被缓存）──────────────────────────────────

const ROUTER_SYSTEM_PROMPT = `你是消息分类路由器。根据已知话题列表和用户消息，判断：
1. 消息属于哪个已知话题，或是否是新话题
2. 消息中提到的实体（项目名、路径、专有名词）
3. 与其他话题的关联关系
4. 需要注入的 history 范围

historyStrategy 选项说明：
- "full"：话题连续进行中（话题置信度高且最近2小时内活跃），注入完整 history
- "recent_20"：话题有间隔（最近24小时内），只取最近20条消息
- "summary_only"：话题较久（>24小时），只注入话题摘要，不注入 history 消息
- "none"：新话题或完全无关，使用干净 context

拆分规则：
- 若消息包含 ≥2 个独立问题/任务（互不依赖，可分别独立回答）→ 拆分为多个 route
- 若问题之间有依赖或共享上下文（如"用A的结果做B"）→ 不拆分，选主话题
- subMessage 必须自含上下文，不能有指代不明的代词（如"它"、"那个"）
- 最多拆分为 3 个 route；若任一 confidence < 0.6 → 不拆分，回退为单 route

只输出 JSON，不作任何解释或回答。输出格式：
{
  "routes": [
    {
      "topicId": "T1",
      "isNewTopic": false,
      "subMessage": "针对该话题的独立问题描述（自含上下文）",
      "historyStrategy": "recent_20",
      "historyHint": "选择此策略的原因（1句话）",
      "relatedTopicIds": [],
      "entityTags": ["项目名", "文件路径"],
      "confidence": 0.92
    }
  ],
  "isMultiTopic": false,
  "splitHint": "单一话题，无需拆分"
}

新话题时 topicId 格式为 "new:{type}"，type 取值：project_query/code_task/general_chat/other`

// ── 核心函数 ────────────────────────────────────────────────────────────────

/**
 * Stage 1：路由消息并组装上下文（返回数组，单话题长度=1，多话题并行处理）
 * 若 LLM 调用失败，自动降级为空 context（服务不中断）
 */
export async function routeAndAssemble(
  userMessage: string,
  topicGraph: TopicGraph,
  llmClient: LLMClient,
  memoryManager: MemoryManager | null,
): Promise<AssembledContext[]> {
  try {
    // 1. 获取活跃话题摘要
    const activeSummaries = topicGraph.getActiveSummaries(20)

    // 2. LLM 路由分类（返回多路由结果）
    const multiRoute = await classifyMessage(userMessage, activeSummaries, llmClient)

    // 3. 限制最多 3 个子任务
    const routes = multiRoute.routes.slice(0, 3)

    if (multiRoute.isMultiTopic) {
      logger.info(`多话题拆分: ${routes.length} 个子任务 (${multiRoute.splitHint})`)
    }

    // 4. 为每个 route 组装独立 context
    const contexts = await Promise.all(
      routes.map(route => buildSubContext(route, activeSummaries, topicGraph, memoryManager))
    )

    return contexts
  } catch (err) {
    logger.error('路由失败，降级为空 context:', err)
    return [buildFallbackContext(userMessage)]
  }
}

/**
 * 为单个 SubRouteResult 组装 AssembledContext
 */
async function buildSubContext(
  route: RouteResult,
  activeSummaries: TopicSummary[],
  topicGraph: TopicGraph,
  memoryManager: MemoryManager | null,
): Promise<AssembledContext> {
  // 1. 确定 topicId（新话题则生成唯一 ID）
  const topicId = resolveTopicId(route, topicGraph)

  // 2. 加载话题 history bucket
  const topicHistory = topicGraph.loadHistory(topicId)

  // 3. 按策略筛选消息
  const messages = selectMessages(topicHistory, route.historyStrategy)

  // 4. 召回 episodic memory
  const episodics = memoryManager
    ? await recallEpisodicMemory(route.entityTags, memoryManager)
    : []

  // 5. 注入相关话题摘要（轻量）
  const relatedSummaries = route.relatedTopicIds.length > 0
    ? activeSummaries.filter(s => route.relatedTopicIds.includes(s.id))
    : []

  // 6. 组装 system prompt
  const systemPrompt = buildSystemPrompt({ episodics, relatedSummaries })

  logger.info(
    `路由完成: ${topicId} (${route.historyStrategy}, confidence=${route.confidence.toFixed(2)}, msgs=${messages.length})`
  )

  return {
    systemPrompt,
    messages,
    topicId,
    subMessage: route.subMessage,
    topicHistory,
    route: { ...route, topicId },
    isFallback: false,
  }
}

// ── LLM 分类 ──────────────────────────────────────────────────────────────

async function classifyMessage(
  userMessage: string,
  activeSummaries: TopicSummary[],
  llmClient: LLMClient,
): Promise<MultiRouteResult> {
  const routerModel = configManager.getConfig().model.routerModel

  // 构建话题摘要列表文本
  const summaryText = activeSummaries.length === 0
    ? '（暂无已知话题）'
    : activeSummaries.map(s => {
        const age = formatAge(Date.now() - s.updatedAt)
        const tags = s.entityTags.length > 0 ? `  实体:[${s.entityTags.join(',')}]` : ''
        return `[${s.id}] 类型:${s.type}  摘要:"${s.summary || '（无摘要）'}"${tags}  最近活跃:${age}  轮次:${s.turnCount}`
      }).join('\n')

  const userPrompt = `已知话题（按最近活跃排序）：\n${summaryText}\n\n用户消息：${userMessage}`

  const response = await llmClient.chatSync({
    model: routerModel,
    maxTokens: 1024,
    system: ROUTER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  return parseMultiRouteResult(response.content, userMessage)
}

function parseMultiRouteResult(content: string, originalMessage: string): MultiRouteResult {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`路由器 LLM 返回非 JSON: ${content.slice(0, 100)}`)
  }

  const parsed = JSON.parse(jsonMatch[0])

  // 兼容旧格式（直接返回单个 route 对象而非 routes 数组）
  if (!Array.isArray(parsed.routes)) {
    const singleRoute = parseSingleRoute(parsed, originalMessage)
    return { routes: [singleRoute], isMultiTopic: false, splitHint: '单路由（兼容格式）' }
  }

  const routes: RouteResult[] = parsed.routes
    .map((r: any) => parseSingleRoute(r, originalMessage))
    .filter((r: RouteResult) => r.confidence >= 0.5)  // 过滤低置信度

  // 若过滤后为空或任一 confidence < 0.6 且多于1个，退化为单路由
  const anyLowConfidence = routes.some(r => r.confidence < 0.6)
  if (routes.length === 0 || (routes.length > 1 && anyLowConfidence)) {
    const fallbackRoute = parseSingleRoute(parsed.routes[0] || {}, originalMessage)
    fallbackRoute.subMessage = originalMessage
    return { routes: [fallbackRoute], isMultiTopic: false, splitHint: '置信度不足，退化为单路由' }
  }

  return {
    routes,
    isMultiTopic: routes.length > 1,
    splitHint: String(parsed.splitHint || ''),
  }
}

function parseSingleRoute(r: any, fallbackMessage: string): RouteResult {
  return {
    topicId: String(r.topicId || 'fallback'),
    isNewTopic: Boolean(r.isNewTopic),
    subMessage: String(r.subMessage || fallbackMessage),
    historyStrategy: validateStrategy(r.historyStrategy),
    historyHint: String(r.historyHint || ''),
    relatedTopicIds: Array.isArray(r.relatedTopicIds) ? r.relatedTopicIds : [],
    entityTags: Array.isArray(r.entityTags) ? r.entityTags : [],
    confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : 0.5,
  }
}

function validateStrategy(value: unknown): HistoryStrategy {
  const valid: HistoryStrategy[] = ['full', 'recent_20', 'summary_only', 'none']
  return valid.includes(value as HistoryStrategy) ? (value as HistoryStrategy) : 'none'
}

// ── 话题 ID 解析 ──────────────────────────────────────────────────────────

function resolveTopicId(route: RouteResult, topicGraph: TopicGraph): string {
  if (!route.isNewTopic) {
    // 已知话题：确保在图中存在
    const type = detectTopicType(route.topicId)
    topicGraph.getOrCreate(route.topicId, type)
    return route.topicId
  }

  // 新话题：生成唯一 ID，格式 T_{timestamp}_{random}
  const rawType = route.topicId.startsWith('new:') ? route.topicId.slice(4) : 'other'
  const type = ['project_query', 'code_task', 'general_chat', 'other'].includes(rawType) ? rawType : 'other'
  const newId = `T_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  topicGraph.getOrCreate(newId, type)
  return newId
}

function detectTopicType(topicId: string): string {
  // 已有话题不需要推断类型，getOrCreate 会从已有记录读取
  return 'other'
}

// ── 消息筛选 ──────────────────────────────────────────────────────────────

function selectMessages(history: MessageHistoryManager, strategy: HistoryStrategy): Message[] {
  const all = history.getMessages()

  switch (strategy) {
    case 'full':
      return all
    case 'recent_20':
      return all.slice(-20)
    case 'summary_only':
    case 'none':
      return []
    default:
      return []
  }
}

// ── Episodic Memory 召回 ──────────────────────────────────────────────────

async function recallEpisodicMemory(
  entityTags: string[],
  memoryManager: MemoryManager,
): Promise<Array<{ content: string; importance: number }>> {
  if (entityTags.length === 0) return []
  try {
    const query = entityTags.join(' ')
    const results = await memoryManager.searchRelevant(query, 3)
    return results
      .filter((m: any) => m.type === 'episodic')
      .map((m: any) => ({ content: m.content, importance: m.importance || 5 }))
  } catch {
    return []
  }
}

// ── System Prompt 组装 ────────────────────────────────────────────────────

function buildSystemPrompt(options: {
  episodics: Array<{ content: string; importance: number }>
  relatedSummaries: TopicSummary[]
}): string {
  const parts: string[] = []

  // 动态注入 ~/data/ 目录
  const dataDir = path.join(os.homedir(), 'data')
  if (fs.existsSync(dataDir)) {
    try {
      const entries = fs.readdirSync(dataDir, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name)
      if (dirs.length > 0) {
        parts.push(`## 用户项目目录（~/data/）\n${dirs.map(d => `- ${d}`).join('\n')}`)
      }
    } catch {
      // 读取失败不影响流程
    }
  }

  // 相关话题摘要注入
  if (options.relatedSummaries.length > 0) {
    const related = options.relatedSummaries
      .map(s => `- [${s.id}] ${s.summary || '（无摘要）'} (实体: ${s.entityTags.join(',')})`)
      .join('\n')
    parts.push(`## 相关话题背景\n${related}`)
  }

  // Episodic memory 注入（few-shot 示例）
  if (options.episodics.length > 0) {
    const examples = options.episodics
      .sort((a, b) => b.importance - a.importance)
      .map(e => `- ${e.content}`)
      .join('\n')
    parts.push(`## 过去类似任务的经验\n${examples}`)
  }

  return parts.join('\n\n')
}

// ── 降级 Context ──────────────────────────────────────────────────────────

function buildFallbackContext(userMessage: string = ''): AssembledContext {
  return {
    systemPrompt: '',
    messages: [],
    topicId: 'fallback',
    subMessage: userMessage,
    topicHistory: new MessageHistoryManager(),
    route: {
      topicId: 'fallback',
      isNewTopic: true,
      subMessage: userMessage,
      historyStrategy: 'none',
      historyHint: '路由失败，降级为空 context',
      relatedTopicIds: [],
      entityTags: [],
      confidence: 0,
    },
    isFallback: true,
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}
