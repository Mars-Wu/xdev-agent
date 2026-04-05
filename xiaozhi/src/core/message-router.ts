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

const logger = createLogger('message-router')

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type HistoryStrategy = 'full' | 'recent_20' | 'summary_only' | 'none'

export interface RouteResult {
  topicId: string
  isNewTopic: boolean
  historyStrategy: HistoryStrategy
  historyHint: string        // LLM 自述选择原因，供调试
  relatedTopicIds: string[]
  entityTags: string[]
  confidence: number         // 0~1
}

export interface AssembledContext {
  systemPrompt: string
  messages: Message[]        // topic history（已按 historyStrategy 筛选）
  topicId: string
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

只输出 JSON，不作任何解释或回答。输出格式：
{
  "topicId": "T1",
  "isNewTopic": false,
  "historyStrategy": "recent_20",
  "historyHint": "选择此策略的原因（1句话）",
  "relatedTopicIds": [],
  "entityTags": ["项目名", "文件路径"],
  "confidence": 0.92
}

新话题时 topicId 格式为 "new:{type}"，type 取值：project_query/code_task/general_chat/other`

// ── 核心函数 ────────────────────────────────────────────────────────────────

/**
 * Stage 1：路由消息并组装上下文
 * 若 LLM 调用失败，自动降级为空 context（服务不中断）
 */
export async function routeAndAssemble(
  userMessage: string,
  topicGraph: TopicGraph,
  llmClient: LLMClient,
  memoryManager: MemoryManager | null,
): Promise<AssembledContext> {
  try {
    // 1. 获取活跃话题摘要
    const activeSummaries = topicGraph.getActiveSummaries(20)

    // 2. LLM 路由分类
    const route = await classifyMessage(userMessage, activeSummaries, llmClient)

    // 3. 确定 topicId（新话题则生成唯一 ID）
    const topicId = resolveTopicId(route, topicGraph)

    // 4. 加载话题 history bucket
    const topicHistory = topicGraph.loadHistory(topicId)

    // 5. 按策略筛选消息
    const messages = selectMessages(topicHistory, route.historyStrategy)

    // 6. 召回 episodic memory
    const episodics = memoryManager
      ? await recallEpisodicMemory(route.entityTags, memoryManager)
      : []

    // 7. 注入相关话题摘要（轻量）
    const relatedSummaries = route.relatedTopicIds.length > 0
      ? activeSummaries.filter(s => route.relatedTopicIds.includes(s.id))
      : []

    // 8. 组装 system prompt
    const systemPrompt = buildSystemPrompt({ episodics, relatedSummaries })

    logger.info(
      `路由完成: ${topicId} (${route.historyStrategy}, confidence=${route.confidence.toFixed(2)}, msgs=${messages.length})`
    )

    return {
      systemPrompt,
      messages,
      topicId,
      topicHistory,
      route: { ...route, topicId },
      isFallback: false,
    }
  } catch (err) {
    logger.error('路由失败，降级为空 context:', err)
    return buildFallbackContext()
  }
}

// ── LLM 分类 ──────────────────────────────────────────────────────────────

async function classifyMessage(
  userMessage: string,
  activeSummaries: TopicSummary[],
  llmClient: LLMClient,
): Promise<RouteResult> {
  const routerModel = process.env.XIAOZHI_ROUTER_MODEL || 'glm-5-turbo'

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
    maxTokens: 512,  // 路由器只输出小 JSON
    system: ROUTER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  return parseRouteResult(response.content)
}

function parseRouteResult(content: string): RouteResult {
  // 提取 JSON（LLM 可能在 JSON 外加文字）
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`路由器 LLM 返回非 JSON: ${content.slice(0, 100)}`)
  }

  const parsed = JSON.parse(jsonMatch[0])

  return {
    topicId: String(parsed.topicId || 'fallback'),
    isNewTopic: Boolean(parsed.isNewTopic),
    historyStrategy: validateStrategy(parsed.historyStrategy),
    historyHint: String(parsed.historyHint || ''),
    relatedTopicIds: Array.isArray(parsed.relatedTopicIds) ? parsed.relatedTopicIds : [],
    entityTags: Array.isArray(parsed.entityTags) ? parsed.entityTags : [],
    confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
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

function buildFallbackContext(): AssembledContext {
  return {
    systemPrompt: '',
    messages: [],
    topicId: 'fallback',
    topicHistory: new MessageHistoryManager(),
    route: {
      topicId: 'fallback',
      isNewTopic: true,
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
