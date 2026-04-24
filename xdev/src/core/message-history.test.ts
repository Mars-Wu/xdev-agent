// src/core/message-history.test.ts (serialize/deserialize/stats 追加测试)
import { describe, it, expect, vi } from 'vitest'
import { MessageHistoryManager } from './message-history'

describe('MessageHistoryManager - serialize / deserialize / stats', () => {

  // ── serialize ──────────────────────────────────────────────────────────────

  describe('serialize', () => {
    it('空 history 序列化为合法 JSON（空数组）', () => {
      const h = new MessageHistoryManager()
      const json = h.serialize()
      expect(() => JSON.parse(json)).not.toThrow()
      expect(JSON.parse(json)).toEqual([])
    })

    it('消息序列化后包含 role 和 content', () => {
      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: 'Hello' })
      h.addMessage({ role: 'assistant', content: 'World' })

      const parsed = JSON.parse(h.serialize())
      expect(parsed).toHaveLength(2)
      expect(parsed[0].role).toBe('user')
      expect(parsed[0].content).toBe('Hello')
      expect(parsed[1].role).toBe('assistant')
    })
  })

  // ── deserialize ────────────────────────────────────────────────────────────

  describe('deserialize', () => {
    it('反序列化后消息数量正确', () => {
      const h1 = new MessageHistoryManager()
      h1.addMessage({ role: 'user', content: '问题1' })
      h1.addMessage({ role: 'assistant', content: '回答1' })
      const json = h1.serialize()

      const h2 = new MessageHistoryManager()
      h2.deserialize(json)
      expect(h2.stats().messageCount).toBe(2)
    })

    it('反序列化后消息内容一致', () => {
      const h1 = new MessageHistoryManager()
      h1.addMessage({ role: 'user', content: 'TqQuant 是什么？' })
      const json = h1.serialize()

      const h2 = new MessageHistoryManager()
      h2.deserialize(json)
      expect(h2.getMessages()[0].content).toBe('TqQuant 是什么？')
    })

    it('deserialize 空字符串：history 被清空', () => {
      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: '将被清空' })
      h.deserialize('')
      expect(h.stats().messageCount).toBe(0)
    })

    it('deserialize 空数组 JSON：history 被清空', () => {
      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: '将被清空' })
      h.deserialize('[]')
      expect(h.stats().messageCount).toBe(0)
    })

    it('deserialize 多次调用：后一次覆盖前一次', () => {
      const h = new MessageHistoryManager()

      const batch1 = JSON.stringify([{ role: 'user', content: '批次1' }])
      const batch2 = JSON.stringify([
        { role: 'user', content: '批次2-A' },
        { role: 'assistant', content: '批次2-B' },
      ])

      h.deserialize(batch1)
      expect(h.stats().messageCount).toBe(1)

      h.deserialize(batch2)
      expect(h.stats().messageCount).toBe(2)
      expect(h.getMessages()[0].content).toBe('批次2-A')
    })
  })

  // ── stats ──────────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('空 history：messageCount=0，estimatedTokens=0', () => {
      const h = new MessageHistoryManager()
      const s = h.stats()
      expect(s.messageCount).toBe(0)
      expect(s.estimatedTokens).toBe(0)
    })

    it('有消息时：messageCount 正确', () => {
      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: 'A' })
      h.addMessage({ role: 'user', content: 'B' })
      h.addMessage({ role: 'assistant', content: 'C' })
      expect(h.stats().messageCount).toBe(3)
    })

    it('有消息时：estimatedTokens > 0', () => {
      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: '这是一段较长的文本，用来估算 token 数量' })
      expect(h.stats().estimatedTokens).toBeGreaterThan(0)
    })

    it('getRecentMessages 返回最后 N 条消息', () => {
      const h = new MessageHistoryManager()
      for (let i = 0; i < 5; i++) {
        h.addMessage({ role: 'user', content: `消息 ${i}` })
      }

      expect(h.getRecentMessages(2).map(msg => msg.content)).toEqual(['消息 3', '消息 4'])
    })
  })

  // ── 往返完整性 ─────────────────────────────────────────────────────────────

  describe('serialize → deserialize 往返', () => {
    it('多条消息往返后内容完全一致', () => {
      const original = new MessageHistoryManager()
      original.addMessage({ role: 'user', content: '第一条消息' })
      original.addMessage({ role: 'assistant', content: '第一条回复' })
      original.addMessage({ role: 'user', content: '第二条消息' })

      const json = original.serialize()

      const restored = new MessageHistoryManager()
      restored.deserialize(json)

      const origMsgs = original.getMessages()
      const restMsgs = restored.getMessages()

      expect(restMsgs).toHaveLength(origMsgs.length)
      origMsgs.forEach((msg, i) => {
        expect(restMsgs[i].role).toBe(msg.role)
        expect(restMsgs[i].content).toBe(msg.content)
      })
    })
  })

  describe('compression', () => {
    it('达到阈值后自动压缩并保留最近消息', () => {
      const h = new MessageHistoryManager({
        maxTokens: 400,
        compressionThreshold: 0.2,
        preserveRecent: 3,
      })
      const onCompression = vi.fn()
      h.onCompression(onCompression)

      for (let i = 0; i < 9; i++) {
        h.addMessage({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `第 ${i} 条消息：这是为了触发压缩而构造的一段很长的上下文文本。`.repeat(4),
        })
      }

      const messages = h.getMessages()
      expect(onCompression).toHaveBeenCalledTimes(1)
      expect(messages.length).toBeLessThan(9)
      expect(messages.some(msg => msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('[历史摘要]'))).toBe(true)
      expect(messages.some(msg => typeof msg.content === 'string' && msg.content.includes('第 8 条消息'))).toBe(true)
    })

    it('会裁剪较早的长 tool_result，但保留最近的 tool_result 原文', () => {
      const h = new MessageHistoryManager()
      const oldResult = {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'tool-1', content: 'A'.repeat(260) }],
      }
      const recentResult = {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'tool-2', content: 'B'.repeat(260) }],
      }

      const [pruned, prunedCount] = (h as any)._pruneOldToolResults([oldResult, recentResult], 1)

      expect(prunedCount).toBe(1)
      expect((pruned[0].content as any[])[0].content).toContain('旧工具输出已清除')
      expect((pruned[1].content as any[])[0].content).toBe('B'.repeat(260))
    })

    it('会移除孤立的 tool_use/tool_result，同时保留完整配对', () => {
      const h = new MessageHistoryManager()
      const cleaned = (h as any)._cleanOrphanedToolPairs([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'paired', name: 'glob', input: { pattern: '**/*.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'paired', content: 'src/index.ts' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'orphan-use', name: 'rg', input: { pattern: 'foo' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'orphan-result', content: 'bar' }],
        },
        {
          role: 'assistant',
          content: '最终回复',
        },
      ])

      expect(cleaned).toHaveLength(3)
      expect(cleaned.some((msg: any) => Array.isArray(msg.content) && msg.content.some((block: any) => block.id === 'paired'))).toBe(true)
      expect(cleaned.some((msg: any) => Array.isArray(msg.content) && msg.content.some((block: any) => block.id === 'orphan-use'))).toBe(false)
      expect(cleaned.some((msg: any) => Array.isArray(msg.content) && msg.content.some((block: any) => block.tool_use_id === 'orphan-result'))).toBe(false)
    })

    it('结构化摘要会包含主要请求、最终响应和工具调用', () => {
      const h = new MessageHistoryManager()
      const summary = (h as any)._createStructuredSummary([
        { role: 'user', content: '请检查 xdev 的 workflow 和话题路由问题。' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'workflow', input: { action: 'summary' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '{"ok":true}' }],
        },
        { role: 'assistant', content: '已经确认 workflow 状态，并定位到路由链路。' },
      ])

      expect(summary).toContain('主要请求')
      expect(summary).toContain('最终响应')
      expect(summary).toContain('执行的工具')
      expect(summary).toContain('workflow')
    })
  })
})
