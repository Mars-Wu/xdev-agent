// src/storage/topic-graph.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { TopicGraph } from './topic-graph'
import { MessageHistoryManager } from '../core/message-history'

function makeTempGraph(): { tg: TopicGraph; tmpDir: string } {
  const tmpDir = path.join(os.tmpdir(), `xiaozhi-tg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tg = new TopicGraph(path.join(tmpDir, 'index.db'))
  tg.init()
  return { tg, tmpDir }
}

describe('TopicGraph', () => {
  let tg: TopicGraph
  let tmpDir: string

  beforeEach(() => {
    ;({ tg, tmpDir } = makeTempGraph())
  })

  afterEach(() => {
    tg.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── getOrCreate ───────────────────────────────────────────────────────────

  describe('getOrCreate', () => {
    it('新话题：创建并返回', () => {
      const topic = tg.getOrCreate('T_001', 'code_task')
      expect(topic.id).toBe('T_001')
      expect(topic.type).toBe('code_task')
      expect(topic.turnCount).toBe(0)
      expect(topic.status).toBe('active')
    })

    it('已存在话题：幂等返回', () => {
      tg.getOrCreate('T_002', 'project_query')
      const second = tg.getOrCreate('T_002', 'project_query')
      expect(second.id).toBe('T_002')
    })

    it('同一 id 调用两次，数据库只有一条记录', () => {
      tg.getOrCreate('T_003', 'general_chat')
      tg.getOrCreate('T_003', 'general_chat')
      const summaries = tg.getActiveSummaries(10)
      expect(summaries.filter(s => s.id === 'T_003').length).toBe(1)
    })
  })

  // ── getActiveSummaries ────────────────────────────────────────────────────

  describe('getActiveSummaries', () => {
    it('按 updated_at 降序返回', async () => {
      tg.getOrCreate('T_old', 'other')
      await new Promise(r => setTimeout(r, 5))
      tg.getOrCreate('T_new', 'other')

      const summaries = tg.getActiveSummaries(10)
      expect(summaries[0].id).toBe('T_new')
      expect(summaries[1].id).toBe('T_old')
    })

    it('limit 参数有效', () => {
      for (let i = 0; i < 5; i++) tg.getOrCreate(`T_limit_${i}`, 'other')
      const summaries = tg.getActiveSummaries(3)
      expect(summaries.length).toBe(3)
    })

    it('空库返回空数组', () => {
      expect(tg.getActiveSummaries(10)).toEqual([])
    })
  })

  // ── updateSummary ─────────────────────────────────────────────────────────

  describe('updateSummary', () => {
    it('更新 summary 和 entityTags', () => {
      tg.getOrCreate('T_sum', 'code_task')
      tg.updateSummary('T_sum', '关于 TqQuant 的量化策略', ['TqQuant', 'Python'])

      const [s] = tg.getActiveSummaries(1)
      expect(s.summary).toBe('关于 TqQuant 的量化策略')
      expect(s.entityTags).toContain('TqQuant')
    })
  })

  // ── incrementTurnCount ────────────────────────────────────────────────────

  describe('incrementTurnCount', () => {
    it('每次调用 +1', () => {
      tg.getOrCreate('T_cnt', 'general_chat')
      tg.incrementTurnCount('T_cnt')
      tg.incrementTurnCount('T_cnt')

      const [s] = tg.getActiveSummaries(1)
      expect(s.turnCount).toBe(2)
    })
  })

  // ── saveHistory / loadHistory ─────────────────────────────────────────────

  describe('saveHistory / loadHistory', () => {
    it('保存后加载，消息数一致', () => {
      tg.getOrCreate('T_hist', 'code_task')

      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: 'Hello' })
      h.addMessage({ role: 'assistant', content: 'World' })
      tg.saveHistory('T_hist', h)

      const loaded = tg.loadHistory('T_hist')
      expect(loaded.stats().messageCount).toBe(2)
    })

    it('不存在的话题 loadHistory 返回空 history', () => {
      const loaded = tg.loadHistory('T_nonexist')
      expect(loaded.stats().messageCount).toBe(0)
    })

    it('消息内容往返一致', () => {
      tg.getOrCreate('T_content', 'other')

      const h = new MessageHistoryManager()
      h.addMessage({ role: 'user', content: 'TqQuant 是什么？' })
      tg.saveHistory('T_content', h)

      const loaded = tg.loadHistory('T_content')
      const msgs = loaded.getMessages()
      expect(msgs[0].content).toBe('TqQuant 是什么？')
    })
  })

  // ── logPipeline ───────────────────────────────────────────────────────────

  describe('logPipeline', () => {
    it('写入不抛出异常', () => {
      tg.getOrCreate('T_log', 'code_task')
      expect(() => tg.logPipeline({
        ts: Date.now(),
        msgPreview: '帮我查看 README',
        topicId: 'T_log',
        isNewTopic: false,
        confidence: 0.95,
        historyStrategy: 'full',
        contextTokens: 1200,
      })).not.toThrow()
    })
  })

  // ── upsertRelation ────────────────────────────────────────────────────────

  describe('upsertRelation', () => {
    it('写入关系后可查询', () => {
      tg.getOrCreate('T_A', 'code_task')
      tg.getOrCreate('T_B', 'project_query')
      tg.upsertRelation('T_A', 'T_B', 'references', 0.8)

      const relations = tg.getRelations('T_A')
      expect(relations.length).toBe(1)
      expect(relations[0].toTopic).toBe('T_B')
      expect(relations[0].relation).toBe('references')
    })

    it('weight 超出 [0,1] 被 clamp', () => {
      tg.getOrCreate('T_clamp_A', 'other')
      tg.getOrCreate('T_clamp_B', 'other')
      tg.upsertRelation('T_clamp_A', 'T_clamp_B', 'related', 999)

      const [r] = tg.getRelations('T_clamp_A')
      expect(r.weight).toBeLessThanOrEqual(1)
    })
  })
})
