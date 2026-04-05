// src/core/message-history.test.ts (serialize/deserialize/stats 追加测试)
import { describe, it, expect } from 'vitest'
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
})
