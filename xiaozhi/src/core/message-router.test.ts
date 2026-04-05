// src/core/message-router.test.ts
//
// 测试重点：
//  - 解析逻辑（parseMultiRouteResult）：新格式/旧格式/低置信度/非JSON
//  - routeAndAssemble：返回正确数量的 AssembledContext，isFallback 降级
//
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
// Note: fs.existsSync is not mockable in ESM; buildSystemPrompt reads ~/data/ harmlessly
import { routeAndAssemble } from './message-router'
import { TopicGraph } from '../storage/topic-graph'

// ── 辅助：创建隔离的测试用 TopicGraph ───────────────────────────────────────

function makeTempGraph(): { tg: TopicGraph; tmpDir: string } {
  const tmpDir = path.join(os.tmpdir(), `xiaozhi-mr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tg = new TopicGraph(path.join(tmpDir, 'index.db'))
  tg.init()
  return { tg, tmpDir }
}

// ── 辅助：构建 mock LLMClient ──────────────────────────────────────────────

function makeMockLLM(responseContent: string) {
  return {
    chatSync: vi.fn().mockResolvedValue({ content: responseContent }),
  } as any
}

// ── 辅助：构建合法的单话题 JSON 响应 ─────────────────────────────────────────

function singleRouteJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    routes: [{
      topicId: 'T_001',
      isNewTopic: false,
      subMessage: '用户消息的子问题',
      historyStrategy: 'recent_20',
      historyHint: '话题24小时内活跃',
      relatedTopicIds: [],
      entityTags: ['TqQuant'],
      confidence: 0.92,
      ...overrides,
    }],
    isMultiTopic: false,
    splitHint: '单一话题，无需拆分',
  })
}

function multiRouteJson(): string {
  return JSON.stringify({
    routes: [
      {
        topicId: 'new:project_query',
        isNewTopic: true,
        subMessage: '帮我查看 TqQuant 项目的 README，总结主要功能',
        historyStrategy: 'none',
        historyHint: '新话题',
        relatedTopicIds: [],
        entityTags: ['TqQuant'],
        confidence: 0.91,
      },
      {
        topicId: 'new:code_task',
        isNewTopic: true,
        subMessage: '将 xiaozhi 项目的日志级别改为 debug',
        historyStrategy: 'none',
        historyHint: '新话题',
        relatedTopicIds: [],
        entityTags: ['xiaozhi'],
        confidence: 0.88,
      },
    ],
    isMultiTopic: true,
    splitHint: '文档查询和代码修改为独立任务，无相互依赖',
  })
}

// ── 测试套件 ──────────────────────────────────────────────────────────────────

describe('routeAndAssemble', () => {
  let tg: TopicGraph
  let tmpDir: string

  beforeEach(() => {
    ;({ tg, tmpDir } = makeTempGraph())
    // 预置已知话题 T_001
    tg.getOrCreate('T_001', 'code_task')
    tg.updateSummary('T_001', '小智代码修改相关', ['xiaozhi'])
  })

  afterEach(() => {
    tg.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ── 单话题 ─────────────────────────────────────────────────────────────────

  it('单话题消息：返回长度为 1 的数组', async () => {
    const llm = makeMockLLM(singleRouteJson())
    const contexts = await routeAndAssemble('帮我看 xiaozhi 的代码', tg, llm, null)

    expect(contexts).toHaveLength(1)
    expect(contexts[0].isFallback).toBe(false)
  })

  it('单话题：topicId 正确映射到已知话题', async () => {
    const llm = makeMockLLM(singleRouteJson())
    const contexts = await routeAndAssemble('帮我看 xiaozhi 的代码', tg, llm, null)

    expect(contexts[0].topicId).toBe('T_001')
  })

  it('单话题：subMessage 来自路由器提炼（不是原始消息）', async () => {
    const llm = makeMockLLM(singleRouteJson({ subMessage: '查看 xiaozhi 代码' }))
    const contexts = await routeAndAssemble('帮我看看 xiaozhi 这个项目的代码，谢谢', tg, llm, null)

    expect(contexts[0].subMessage).toBe('查看 xiaozhi 代码')
  })

  // ── 多话题 ─────────────────────────────────────────────────────────────────

  it('多话题消息：返回长度为 2 的数组', async () => {
    const llm = makeMockLLM(multiRouteJson())
    const contexts = await routeAndAssemble(
      '帮我看看 TqQuant README，顺便把 xiaozhi 日志级别改成 debug',
      tg, llm, null,
    )

    expect(contexts).toHaveLength(2)
    expect(contexts.every(c => !c.isFallback)).toBe(true)
  })

  it('多话题：每个 context 的 subMessage 独立', async () => {
    const llm = makeMockLLM(multiRouteJson())
    const contexts = await routeAndAssemble('多话题消息', tg, llm, null)

    const subMessages = contexts.map(c => c.subMessage)
    expect(subMessages[0]).toContain('TqQuant')
    expect(subMessages[1]).toContain('xiaozhi')
  })

  it('多话题：超过 3 个 route 时截断为 3 个', async () => {
    const routes = Array.from({ length: 5 }, (_, i) => ({
      topicId: `new:other`,
      isNewTopic: true,
      subMessage: `子问题 ${i}`,
      historyStrategy: 'none',
      historyHint: '',
      relatedTopicIds: [],
      entityTags: [],
      confidence: 0.85,
    }))
    const llm = makeMockLLM(JSON.stringify({ routes, isMultiTopic: true, splitHint: '测试' }))
    const contexts = await routeAndAssemble('多话题', tg, llm, null)

    expect(contexts.length).toBeLessThanOrEqual(3)
  })

  // ── 低置信度保护 ───────────────────────────────────────────────────────────

  it('任一话题 confidence < 0.6，退化为单路由', async () => {
    const lowConfJson = JSON.stringify({
      routes: [
        { topicId: 'new:other', isNewTopic: true, subMessage: 'A', historyStrategy: 'none', historyHint: '', relatedTopicIds: [], entityTags: [], confidence: 0.9 },
        { topicId: 'new:other', isNewTopic: true, subMessage: 'B', historyStrategy: 'none', historyHint: '', relatedTopicIds: [], entityTags: [], confidence: 0.4 },
      ],
      isMultiTopic: true,
      splitHint: '其中一个置信度低',
    })
    const llm = makeMockLLM(lowConfJson)
    const contexts = await routeAndAssemble('消息', tg, llm, null)

    expect(contexts).toHaveLength(1)
  })

  // ── 旧格式兼容 ─────────────────────────────────────────────────────────────

  it('旧格式（非 routes 数组）：自动包装为 length=1 数组', async () => {
    const oldFormatJson = JSON.stringify({
      topicId: 'T_001',
      isNewTopic: false,
      historyStrategy: 'recent_20',
      historyHint: '兼容测试',
      relatedTopicIds: [],
      entityTags: [],
      confidence: 0.88,
    })
    const llm = makeMockLLM(oldFormatJson)
    const contexts = await routeAndAssemble('旧格式消息', tg, llm, null)

    expect(contexts).toHaveLength(1)
    expect(contexts[0].isFallback).toBe(false)
  })

  it('旧格式：subMessage 回退为原始消息', async () => {
    const oldFormatJson = JSON.stringify({
      topicId: 'T_001',
      isNewTopic: false,
      historyStrategy: 'none',
      historyHint: '',
      relatedTopicIds: [],
      entityTags: [],
      confidence: 0.88,
      // 没有 subMessage 字段
    })
    const llm = makeMockLLM(oldFormatJson)
    const originalMsg = '旧格式消息原文'
    const contexts = await routeAndAssemble(originalMsg, tg, llm, null)

    expect(contexts[0].subMessage).toBe(originalMsg)
  })

  // ── 降级（LLM 失败）─────────────────────────────────────────────────────────

  it('LLM 返回非 JSON：返回 isFallback=true 的 context', async () => {
    const llm = makeMockLLM('抱歉，我无法处理这个请求。')
    const contexts = await routeAndAssemble('任意消息', tg, llm, null)

    expect(contexts).toHaveLength(1)
    expect(contexts[0].isFallback).toBe(true)
  })

  it('LLM 调用抛出异常：返回 isFallback=true 的 context', async () => {
    const llm = { chatSync: vi.fn().mockRejectedValue(new Error('网络超时')) } as any
    const contexts = await routeAndAssemble('任意消息', tg, llm, null)

    expect(contexts).toHaveLength(1)
    expect(contexts[0].isFallback).toBe(true)
  })

  // ── historyStrategy 筛选 ───────────────────────────────────────────────────

  it('historyStrategy=none：messages 为空数组', async () => {
    // 预先存些历史
    const h = tg.loadHistory('T_001')
    h.addMessage({ role: 'user', content: '历史消息' })
    tg.saveHistory('T_001', h)

    const llm = makeMockLLM(singleRouteJson({ historyStrategy: 'none' }))
    const contexts = await routeAndAssemble('消息', tg, llm, null)

    expect(contexts[0].messages).toHaveLength(0)
  })

  it('historyStrategy=full：messages 包含全部历史', async () => {
    // 预先存 3 条历史
    const h = tg.loadHistory('T_001')
    for (let i = 0; i < 3; i++) h.addMessage({ role: 'user', content: `历史 ${i}` })
    tg.saveHistory('T_001', h)

    const llm = makeMockLLM(singleRouteJson({ historyStrategy: 'full' }))
    const contexts = await routeAndAssemble('消息', tg, llm, null)

    expect(contexts[0].messages).toHaveLength(3)
  })
})
