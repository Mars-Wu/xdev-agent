import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./auxiliary-client', () => ({
  auxChatMessages: vi.fn(),
}))

import { auxChatMessages } from './auxiliary-client'
import {
  buildExecutionSummary,
  runBackgroundPass,
  triggerMemoryExtraction,
} from './background-memory'

describe('background-memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runBackgroundPass 会写入实体标签、关系和 episodic 记忆', async () => {
    const llmClient = {
      chatSync: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          newEntityTags: ['xdev', { name: 'workflow', confidence: 0.83 }],
          topicRelations: [
            {
              toTopicId: 'T_related',
              relation: '共享 workflow 状态排查上下文',
              weight: 0.66,
              confidence: 0.71,
              provenance: 'llm_inferred',
              evidence: '都涉及 export-status',
            },
            {
              toTopicId: 'T_ignored',
              relation: '弱关联',
              weight: 0.1,
            },
          ],
          episodicPattern: {
            patternType: 'workflow_debug',
            approach: '先检查 export-status，再对照最近工作流日志。',
            outcome: 'success',
            shouldSave: true,
            confidence: 0.79,
            reason: '这是可复用的排查套路',
            machineVerified: true,
          },
        }),
      }),
    } as any

    const topicGraph = {
      updateEntityTags: vi.fn(),
      upsertRelation: vi.fn(),
    } as any

    const memoryManager = {
      addMemory: vi.fn().mockResolvedValue('mem-1'),
    } as any

    await runBackgroundPass(
      {
        topicId: 'T_main',
        topicType: 'code_task',
        executionSummary: '1. export-status({"scope":"all"})\n2. workflow({"action":"summary"})',
      },
      llmClient,
      topicGraph,
      memoryManager,
    )

    expect(topicGraph.updateEntityTags).toHaveBeenCalledWith('T_main', ['xdev', 'workflow'])
    expect(topicGraph.upsertRelation).toHaveBeenCalledTimes(1)
    expect(topicGraph.upsertRelation).toHaveBeenCalledWith(
      'T_main',
      'T_related',
      '共享 workflow 状态排查上下文',
      0.66,
      expect.objectContaining({
        confidence: 0.71,
        provenance: 'llm_inferred',
        evidence: '都涉及 export-status',
      }),
    )
    expect(memoryManager.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: '先检查 export-status，再对照最近工作流日志。',
      tags: ['T_main', 'workflow_debug'],
      metadata: expect.objectContaining({
        topicId: 'T_main',
        patternType: 'workflow_debug',
        outcome: 'success',
        provenance: 'background_pass',
        machineVerified: true,
      }),
    }))
  })

  it('triggerMemoryExtraction 会从多轮对话中保存 semantic 记忆', async () => {
    vi.mocked(auxChatMessages).mockResolvedValue(`[
      {
        "content": "用户偏好飞书回复简洁并直接给结论。",
        "category": "preference",
        "importance": 8,
        "confidence": 0.86,
        "reason": "用户多次强调输出要简洁"
      }
    ]`)

    const memoryManager = {
      addMemory: vi.fn().mockResolvedValue('mem-2'),
    } as any

    triggerMemoryExtraction(
      {
        topicId: 'T_topic',
        messages: [
          { role: 'user', content: '以后请直接给结论。' },
          { role: 'assistant', content: '收到。' },
          { role: 'user', content: '飞书里也尽量简短一点。' },
          { role: 'assistant', content: '明白，会保持简洁。' },
        ],
      },
      memoryManager,
    )

    await vi.runAllTimersAsync()

    expect(auxChatMessages).toHaveBeenCalledTimes(1)
    expect(memoryManager.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: '用户偏好飞书回复简洁并直接给结论。',
      category: 'preference',
      tags: ['T_topic'],
      metadata: expect.objectContaining({
        topicId: 'T_topic',
        provenance: 'memory_extraction',
        sourceSampleCount: 4,
      }),
    }))
  })

  it('triggerMemoryExtraction 在用户消息不足 2 条时跳过', async () => {
    const memoryManager = {
      addMemory: vi.fn(),
    } as any

    triggerMemoryExtraction(
      {
        topicId: 'T_topic',
        messages: [
          { role: 'user', content: '只说了一句。' },
          { role: 'assistant', content: '收到。' },
        ],
      },
      memoryManager,
    )

    await vi.runAllTimersAsync()

    expect(auxChatMessages).not.toHaveBeenCalled()
    expect(memoryManager.addMemory).not.toHaveBeenCalled()
  })

  it('buildExecutionSummary 会优先汇总工具调用，没有工具时回退到最终回复', () => {
    expect(buildExecutionSummary([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'workflow', input: { action: 'summary' } }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'map', input: { scope: 'src' } }],
      },
    ])).toContain('1. workflow(')

    expect(buildExecutionSummary([
      {
        role: 'assistant',
        content: [{ type: 'text', text: '已经整理好结果。' }],
      },
    ])).toContain('最终回复：已经整理好结果。')
  })
})
