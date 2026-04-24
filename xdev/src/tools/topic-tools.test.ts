import { describe, expect, it, vi } from 'vitest'
import {
  createSaveMemoryTool,
  createTopicTools,
  createUpdateTopicSummaryTool,
} from './topic-tools'

describe('topic-tools', () => {
  it('save_memory 会带上 topicId 和 entity tags 保存记忆', async () => {
    const memoryManager = {
      addMemory: vi.fn().mockResolvedValue('mem-12345678'),
    } as any

    const tool = createSaveMemoryTool(memoryManager, () => 'T_memory')
    const result = await tool.execute({
      content: 'xdev 的 workflow 问题优先看 export-status。',
      type: 'episodic',
      importance: 9,
      entityTags: ['xdev', 'workflow'],
    })

    expect(result.success).toBe(true)
    expect(memoryManager.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: 'xdev 的 workflow 问题优先看 export-status。',
      importance: 9,
      tags: ['xdev', 'workflow', 'T_memory'],
      metadata: { topicId: 'T_memory' },
    }))
  })

  it('update_topic_summary 会截断过长摘要并写入实体标签', async () => {
    const topicGraph = {
      updateSummary: vi.fn(),
    } as any

    const tool = createUpdateTopicSummaryTool(topicGraph, () => 'T_summary')
    const longSummary = '这是一个很长的摘要。'.repeat(30)
    const result = await tool.execute({
      summary: longSummary,
      entityTags: ['xdev', 'doctor'],
    })

    expect(result.success).toBe(true)
    expect(topicGraph.updateSummary).toHaveBeenCalledWith(
      'T_summary',
      longSummary.slice(0, 200),
      ['xdev', 'doctor'],
    )
  })

  it('createTopicTools 返回成组的记忆与摘要工具', () => {
    const tools = createTopicTools({ addMemory: vi.fn() } as any, { updateSummary: vi.fn() } as any, 'T_group')

    expect(tools.map(tool => tool.definition.name)).toEqual(['save_memory', 'update_topic_summary'])
  })
})
