// src/tools/topic-tools.ts
// 热路径记录工具：主 LLM 在 Stage 2 中自主决定写入记忆和更新话题摘要
//
// 工具 1: save_memory    - 永久存入语义或情节记忆
// 工具 2: update_topic_summary - 更新当前话题摘要（供后续路由器使用）

import { createLogger } from '../utils/logger'
import type { MemoryManager } from '../memory/memory-manager'
import type { TopicGraph } from '../storage/topic-graph'
import { MemoryType, MemoryScope } from '../memory/types'
import { createTool, successResult, errorResult } from './tool-interface'
import type { Tool } from './tool-interface'

const logger = createLogger('topic-tools')

// ── save_memory 工具 ──────────────────────────────────────────────────────

export function createSaveMemoryTool(
  memoryManager: MemoryManager,
  getTopicId: () => string,
): Tool {
  return createTool(
    {
      name: 'save_memory',
      description: `将重要信息永久存入长期记忆。

注意：这是内部记录动作，不是对用户的最终回复。调用成功后必须继续完成用户原问题；除非用户明确要求“帮我记住”，不要只回复“已记住”。

调用时机：
- 发现关于某个项目/系统的重要技术事实（如框架、入口文件、关键API）
- 发现用户的偏好或工作习惯
- 完成一类任务，总结出可复用的解决方法（episodic）
- 需要跨话题共享的知识

不需要调用的场景：
- 普通问答、闲聊
- 临时性信息（如"今天的任务"）
- 已经显而易见的常识`,
      parameters: {
        content: {
          type: 'string',
          description: '要记住的内容，1-3句，简洁准确',
        },
        type: {
          type: 'string',
          enum: ['semantic', 'episodic'],
          description: 'semantic=事实/偏好/约定，episodic=解决某类问题的方法和过程',
        },
        importance: {
          type: 'number',
          description: '重要性评分 1-10，10最重要',
          minimum: 1,
          maximum: 10,
        },
        entityTags: {
          type: 'array',
          items: { type: 'string' },
          description: '相关实体标签，如项目名、技术名称（可选）',
        },
      },
      required: ['content', 'type', 'importance'],
    },
    async (input) => {
      const content = String(input.content || '')
      const type = input.type === 'episodic' ? MemoryType.EPISODIC : MemoryType.SEMANTIC
      const importance = Math.min(10, Math.max(1, Number(input.importance) || 5))
      const entityTags = Array.isArray(input.entityTags) ? (input.entityTags as string[]) : []
      const topicId = getTopicId()

      // 标签：entityTags + topicId（便于话题级检索）
      const tags = [...new Set([...entityTags, topicId])]

      try {
        const id = await memoryManager.addMemory({
          content,
          type,
          scope: MemoryScope.PRIVATE,
          category: type === MemoryType.EPISODIC ? 'procedure' : 'fact',
          importance,
          tags,
          metadata: { topicId },
        })
        logger.info(`save_memory: ${id.slice(0, 8)}... type=${type} importance=${importance}`)
        return successResult(`记忆已保存 (id: ${id.slice(0, 8)})`)
      } catch (err) {
        logger.error('save_memory 失败:', err)
        return errorResult(`记忆保存失败: ${String(err)}`)
      }
    },
  )
}

// ── update_topic_summary 工具 ─────────────────────────────────────────────

export function createUpdateTopicSummaryTool(
  topicGraph: TopicGraph,
  getTopicId: () => string,
): Tool {
  return createTool(
    {
      name: 'update_topic_summary',
      description: `更新当前话题的摘要描述。

注意：这是内部维护动作，不是对用户的最终回复。调用成功后继续回答用户问题，不要只回复“摘要已更新”。

调用时机：
- 完成一个完整的子任务或阶段性工作后
- 话题的核心内容发生了重要变化
- 发现了新的关键实体（项目名、技术名）

好的摘要：简洁（1-2句），包含话题的核心内容和主要实体，便于路由器识别。
不好的摘要：流水账、过于详细、包含具体代码。`,
      parameters: {
        summary: {
          type: 'string',
          description: '话题摘要，1-2句，描述话题的核心内容和目标',
        },
        entityTags: {
          type: 'array',
          items: { type: 'string' },
          description: '话题涉及的主要实体（项目名、技术框架、文件路径等）',
        },
      },
      required: ['summary'],
    },
    async (input) => {
      const summary = String(input.summary || '').slice(0, 200)
      const entityTags = Array.isArray(input.entityTags) ? (input.entityTags as string[]) : []
      const topicId = getTopicId()

      try {
        topicGraph.updateSummary(topicId, summary, entityTags.length > 0 ? entityTags : undefined)
        logger.info(`update_topic_summary: ${topicId} -> "${summary.slice(0, 50)}"`)
        return successResult('话题摘要已更新')
      } catch (err) {
        logger.error('update_topic_summary 失败:', err)
        return errorResult(`话题摘要更新失败: ${String(err)}`)
      }
    },
  )
}

/**
 * 创建话题相关工具集合（注入 topicId 上下文）
 */
export function createTopicTools(
  memoryManager: MemoryManager,
  topicGraph: TopicGraph,
  topicId: string,
): Tool[] {
  // 用 getter 支持运行时动态更新 topicId（如降级 fallback 时）
  const getTopicId = () => topicId

  return [
    createSaveMemoryTool(memoryManager, getTopicId),
    createUpdateTopicSummaryTool(topicGraph, getTopicId),
  ]
}
