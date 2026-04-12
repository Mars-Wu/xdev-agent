// src/core/background-memory.ts
// 后台 LLM Pass：Stage 2 结束后异步执行，不阻塞飞书回复
//
// 职责：
//   - 用 glm-4.7-flash 分析本次执行摘要（免费，异步，不影响主流程）
//   - LLM 决定提取哪些实体标签、话题关系、episodic pattern
//   - 写入话题图和 MemoryManager
//   - （新）从完整对话消息中提取 preference/feedback/convention/decision 类记忆
//
// 设计原则：失败不影响主流程，用 try/catch 全包

import { createLogger } from '../utils/logger'
import type { LLMClient } from './llm-client'
import type { MemoryManager } from '../memory/memory-manager'
import type { TopicGraph } from '../storage/topic-graph'
import { MemoryType, MemoryScope } from '../memory/types'
import { configManager } from '../config'
import { auxChatMessages } from './auxiliary-client'

const logger = createLogger('background-memory')

// ── 类型定义 ──────────────────────────────────────────────────────────────

export interface BackgroundPassInput {
  topicId: string
  topicType?: string
  executionSummary: string   // 本次 Stage 2 的执行摘要（压缩版）
}

interface BackgroundPassResult {
  newEntityTags: string[]
  topicRelations: Array<{
    toTopicId: string
    relation: string
    weight: number
  }>
  episodicPattern: {
    patternType?: string
    approach?: string
    outcome?: string
    shouldSave: boolean
  }
}

// ── 后台 LLM System Prompt（固定）────────────────────────────────────────

const BG_SYSTEM_PROMPT = `你是记忆整理助手。分析一次对话的执行摘要，提取值得记录的信息。

输出 JSON，格式：
{
  "newEntityTags": ["实体1", "实体2"],
  "topicRelations": [
    { "toTopicId": "T1", "relation": "关系描述（1句）", "weight": 0.3 }
  ],
  "episodicPattern": {
    "patternType": "project_code_review",
    "approach": "解决这类问题的方法（1-2句）",
    "outcome": "success 或 partial 或 failed",
    "shouldSave": true
  }
}

topicRelations 规则：
- weight 范围 0~1，表示关联强度
- 只记录有实质性关联的话题（weight > 0.2），无关联时返回空数组
- 没有其他活跃话题时返回空数组

episodicPattern.shouldSave 规则：
- true：发现了可复用的解决方法（值得下次参考）
- false：普通问答或无特别方法论价值

只输出 JSON，不作任何解释。`

// ── 核心函数 ──────────────────────────────────────────────────────────────

/**
 * 触发后台 LLM Pass（fire-and-forget，不阻塞调用方）
 */
export function triggerBackgroundPass(
  input: BackgroundPassInput,
  llmClient: LLMClient,
  topicGraph: TopicGraph,
  memoryManager: MemoryManager,
): void {
  // 不 await，让它在后台运行
  setImmediate(() => {
    try {
      runBackgroundPass(input, llmClient, topicGraph, memoryManager).catch(err => {
        logger.error(`后台 Pass 异常 (topicId=${input.topicId}):`, err)
      })
    } catch (err) {
      logger.error(`后台 Pass 启动异常 (topicId=${input.topicId}):`, err)
    }
  })
}

/**
 * 运行后台 LLM Pass（可 await，测试时使用）
 */
export async function runBackgroundPass(
  input: BackgroundPassInput,
  llmClient: LLMClient,
  topicGraph: TopicGraph,
  memoryManager: MemoryManager,
): Promise<void> {
  const backgroundModel = configManager.getConfig().model.backgroundModel

  try {
    // 限制 executionSummary 长度，避免 bg pass 浪费 token
    const truncatedSummary = input.executionSummary.slice(0, 3000)

    const userPrompt = `话题ID：${input.topicId}
话题类型：${input.topicType || 'unknown'}
执行摘要：
${truncatedSummary}`

    const response = await llmClient.chatSync({
      model: backgroundModel,
      maxTokens: 512,
      system: BG_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    const result = parseBgResult(response.content)
    await applyBgResult(input.topicId, result, topicGraph, memoryManager)

    logger.info(
      `后台 Pass 完成: ${input.topicId} ` +
      `(实体:${result.newEntityTags.length} 关系:${result.topicRelations.length} ` +
      `episodic:${result.episodicPattern.shouldSave})`
    )
  } catch (err) {
    // 后台任务失败不影响主流程
    logger.warn(`后台 Pass 失败 (topicId=${input.topicId}):`, err)
  }
}

// ── 解析和应用结果 ────────────────────────────────────────────────────────

function parseBgResult(content: string): BackgroundPassResult {
  const jsonMatch = content.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return emptyResult()
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      newEntityTags: Array.isArray(parsed.newEntityTags) ? parsed.newEntityTags : [],
      topicRelations: Array.isArray(parsed.topicRelations)
        ? parsed.topicRelations.filter((r: any) => r.toTopicId && r.relation)
        : [],
      episodicPattern: {
        patternType: parsed.episodicPattern?.patternType,
        approach: parsed.episodicPattern?.approach,
        outcome: parsed.episodicPattern?.outcome,
        shouldSave: Boolean(parsed.episodicPattern?.shouldSave),
      },
    }
  } catch {
    return emptyResult()
  }
}

async function applyBgResult(
  topicId: string,
  result: BackgroundPassResult,
  topicGraph: TopicGraph,
  memoryManager: MemoryManager,
): Promise<void> {
  // 1. 更新实体标签
  if (result.newEntityTags.length > 0) {
    topicGraph.updateEntityTags(topicId, result.newEntityTags)
  }

  // 2. 写入话题关系
  for (const rel of result.topicRelations) {
    if (rel.weight > 0.2) {
      topicGraph.upsertRelation(topicId, rel.toTopicId, rel.relation, rel.weight)
    }
  }

  // 3. 保存 episodic pattern
  if (result.episodicPattern.shouldSave && result.episodicPattern.approach) {
    const content = result.episodicPattern.approach
    await memoryManager.addMemory({
      content,
      type: MemoryType.EPISODIC,
      scope: MemoryScope.PRIVATE,
      category: 'procedure',
      importance: 6,
      tags: [topicId, result.episodicPattern.patternType || 'general'].filter(Boolean),
      metadata: {
        topicId,
        patternType: result.episodicPattern.patternType,
        outcome: result.episodicPattern.outcome,
      },
    })
  }
}

function emptyResult(): BackgroundPassResult {
  return {
    newEntityTags: [],
    topicRelations: [],
    episodicPattern: { shouldSave: false },
  }
}

/**
 * 从 agent loop 的 history 生成执行摘要（工具调用列表）
 */
export function buildExecutionSummary(messages: Array<{ role: string; content: any }>): string {
  const parts: string[] = []
  let toolCount = 0

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCount++
        const inputStr = JSON.stringify(block.input || {}).slice(0, 100)
        parts.push(`${toolCount}. ${block.name}(${inputStr})`)
      } else if (block.type === 'text' && block.text && toolCount === 0) {
        // 第一个文本响应（无工具调用的最终回复摘要）
        parts.push(`最终回复：${block.text.slice(0, 200)}`)
      }
    }
  }

  return parts.join('\n') || '（无工具调用，直接回答）'
}

// ── 记忆提取（从完整对话消息） ────────────────────────────────────────────

const MEMORY_EXTRACT_SYSTEM = `你是记忆提取助手。从对话中找出值得长期记住的信息。

只提取以下4类，其他忽略：
1. preference（用户偏好/习惯）
2. feedback（用户纠正/评价，如"不要这样做"、"上次方法不好"）
3. convention（项目约定/规范）
4. decision（重要技术决策及原因）

输出 JSON 数组（如无则返回 []）：
[
  {
    "content": "简洁一句话",
    "category": "preference|feedback|convention|decision",
    "importance": 1-10
  }
]

只输出 JSON，不解释。`

export interface MemoryExtractionInput {
  topicId: string
  messages: Array<{ role: string; content: any }>
}

/**
 * 触发记忆提取（fire-and-forget）
 * 从完整对话消息中提取 preference/feedback/convention/decision 类记忆。
 * 使用辅助模型（glm-4.7-flash）保持低成本。
 * 触发条件：对话中至少有 2 条用户消息。
 */
export function triggerMemoryExtraction(
  input: MemoryExtractionInput,
  memoryManager: MemoryManager,
): void {
  // 至少 2 条用户消息才值得提取
  const userMsgCount = input.messages.filter(m => m.role === 'user').length
  if (userMsgCount < 2) return

  setImmediate(() => {
    runMemoryExtraction(input, memoryManager).catch(err => {
      logger.warn(`记忆提取异常 (topicId=${input.topicId}):`, err)
    })
  })
}

async function runMemoryExtraction(
  input: MemoryExtractionInput,
  memoryManager: MemoryManager,
): Promise<void> {
  // 构建对话文本（只取 user/assistant 文本，截断避免超 token）
  const lines: string[] = []
  for (const msg of input.messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    const text = extractTextContent(msg.content)
    if (!text) continue
    lines.push(`[${msg.role === 'user' ? '用户' : '助手'}] ${text.slice(0, 300)}`)
    if (lines.length >= 20) break  // 最多取前 20 轮
  }
  const conversationText = lines.join('\n')
  if (!conversationText) return

  const raw = await auxChatMessages({
    system: MEMORY_EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: `对话内容：\n${conversationText}` }],
    maxTokens: 512,
  })
  if (!raw) return

  const jsonMatch = raw.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return

  let items: Array<{ content: string; category: string; importance: number }>
  try {
    items = JSON.parse(jsonMatch[0])
  } catch {
    return
  }
  if (!Array.isArray(items) || items.length === 0) return

  let saved = 0
  for (const item of items) {
    if (!item.content || !item.category) continue
    const validCategories = ['preference', 'feedback', 'convention', 'decision']
    if (!validCategories.includes(item.category)) continue

    try {
      await memoryManager.addMemory({
        content: item.content,
        type: MemoryType.SEMANTIC,
        scope: MemoryScope.PRIVATE,
        category: item.category as any,
        importance: Math.min(10, Math.max(1, item.importance || 6)),
        tags: [input.topicId],
      })
      saved++
    } catch {
      // 单条保存失败不中止
    }
  }

  if (saved > 0) {
    logger.info(`记忆提取完成: topicId=${input.topicId} 新增 ${saved} 条`)
  }
}

function extractTextContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join(' ')
  }
  return ''
}
