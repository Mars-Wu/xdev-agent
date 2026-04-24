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
  const tmpDir = path.join(os.tmpdir(), `xdev-mr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
        subMessage: '将 xdev 项目的日志级别改为 debug',
        historyStrategy: 'none',
        historyHint: '新话题',
        relatedTopicIds: [],
        entityTags: ['xdev'],
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
    tg.updateSummary('T_001', '艾克斯代码修改相关', ['xdev'])
  })

  afterEach(() => {
    tg.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ── 单话题 ─────────────────────────────────────────────────────────────────

  it('单话题消息：返回长度为 1 的数组', async () => {
    const llm = makeMockLLM(singleRouteJson())
    const contexts = await routeAndAssemble('帮我看 xdev 的代码', tg, llm, null)

    expect(contexts).toHaveLength(1)
    expect(contexts[0].isFallback).toBe(false)
  })

  it('单话题：topicId 正确映射到已知话题', async () => {
    const llm = makeMockLLM(singleRouteJson())
    const contexts = await routeAndAssemble('帮我看 xdev 的代码', tg, llm, null)

    expect(contexts[0].topicId).toBe('T_001')
  })

  it('单话题：subMessage 来自路由器提炼（不是原始消息）', async () => {
    const llm = makeMockLLM(singleRouteJson({ subMessage: '查看 xdev 代码' }))
    const contexts = await routeAndAssemble('帮我看看 xdev 这个项目的代码，谢谢', tg, llm, null)

    expect(contexts[0].subMessage).toBe('查看 xdev 代码')
  })

  it('模糊回指：最近连续信号足够时，优先续接上一话题', async () => {
    const llm = {
      chatSync: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          shouldContinue: true,
          topicId: 'T_001',
          rewrittenMessage: '在上一条测试消息中，标识字符串是什么？',
          confidence: 0.93,
          reason: '当前消息中的“刚才那条”明显承接最近一轮',
        }),
      }),
    } as any

    const contexts = await routeAndAssemble(
      '刚才那条测试消息里的标识是什么？只回复标识字符串。',
      tg,
      llm,
      null,
      {
        recentTurns: [{
          topicId: 'T_001',
          userMessage: 'SCPT-1776233410 请用一句话回答当前会话类型。',
          assistantReply: '飞书单聊。',
          timestamp: Date.now(),
        }],
      },
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].topicId).toBe('T_001')
    expect(contexts[0].subMessage).toContain('上一轮助手回复如下')
    expect(contexts[0].subMessage).toContain('刚才那条测试消息里的标识是什么')
    expect(llm.chatSync).not.toHaveBeenCalled()
  })

  it('显式编号续问：无需额外 LLM 判断也会续接上一轮回答', async () => {
    const llm = { chatSync: vi.fn() } as any

    const contexts = await routeAndAssemble(
      '把第二项能力展开成 3 条要点，并尽量结合当前 xdev 项目。',
      tg,
      llm,
      null,
      {
        recentTurns: [{
          topicId: 'T_001',
          userMessage: '你好，艾克斯。请用一句话说明你是谁，并列出你当前最核心的三项能力。',
          assistantReply: '我是艾克斯。三项核心能力：1. 系统管理 2. 飞书集成 3. 编程与自动化。',
          timestamp: Date.now(),
        }],
      },
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].topicId).toBe('T_001')
    expect(contexts[0].subMessage).toContain('上一轮助手回复如下')
    expect(llm.chatSync).not.toHaveBeenCalled()
  })

  it('连续信号不足：回退到全局 topic 路由', async () => {
    const llm = {
      chatSync: vi.fn()
        .mockResolvedValueOnce({
          content: JSON.stringify({
            shouldContinue: false,
            confidence: 0.21,
            reason: '当前消息更像独立新任务',
          }),
        })
        .mockResolvedValueOnce({ content: singleRouteJson() }),
    } as any

    const contexts = await routeAndAssemble(
      '帮我看 xdev 的代码',
      tg,
      llm,
      null,
      {
        recentTurns: [{
          topicId: 'T_001',
          userMessage: '上一轮在讨论测试标识。',
          assistantReply: '飞书单聊。',
          timestamp: Date.now(),
        }],
      },
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].topicId).toBe('T_001')
    expect(llm.chatSync).toHaveBeenCalledTimes(2)
  })

  // ── 多话题 ─────────────────────────────────────────────────────────────────

  it('多话题消息：返回长度为 2 的数组', async () => {
    const llm = makeMockLLM(multiRouteJson())
    const contexts = await routeAndAssemble(
      '帮我看看 TqQuant README，顺便把 xdev 日志级别改成 debug',
      tg, llm, null,
    )

    expect(contexts).toHaveLength(2)
    expect(contexts.every(c => !c.isFallback)).toBe(true)
  })

  it('显式两件事提问：无需 router LLM 也会拆分为多个子问题', async () => {
    const llm = { chatSync: vi.fn() } as any
    const contexts = await routeAndAssemble(
      '请分别回答两件事：第一，xdev doctor 是做什么的；第二，workflow 工具现在支持哪些阶段化能力。',
      tg,
      llm,
      null,
    )

    expect(contexts).toHaveLength(2)
    expect(contexts[0].subMessage).toContain('xdev doctor')
    expect(contexts[1].subMessage).toContain('workflow')
    expect(llm.chatSync).not.toHaveBeenCalled()
  })

  it('多话题：每个 context 的 subMessage 独立', async () => {
    const llm = makeMockLLM(multiRouteJson())
    const contexts = await routeAndAssemble('多话题消息', tg, llm, null)

    const subMessages = contexts.map(c => c.subMessage)
    expect(subMessages[0]).toContain('TqQuant')
    expect(subMessages[1]).toContain('xdev')
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

  it('historyStrategy=recent_20：只保留最近 20 条历史', async () => {
    const h = tg.loadHistory('T_001')
    for (let i = 0; i < 25; i++) h.addMessage({ role: 'user', content: `历史 ${i}` })
    tg.saveHistory('T_001', h)

    const llm = makeMockLLM(singleRouteJson({ historyStrategy: 'recent_20' }))
    const contexts = await routeAndAssemble('消息', tg, llm, null)

    expect(contexts[0].messages).toHaveLength(20)
    expect(contexts[0].messages[0].content).toBe('历史 5')
    expect(contexts[0].messages[19].content).toBe('历史 24')
  })

  it('historyStrategy=summary_only：不注入原始历史消息', async () => {
    const h = tg.loadHistory('T_001')
    h.addMessage({ role: 'user', content: '历史消息 1' })
    h.addMessage({ role: 'assistant', content: '历史消息 2' })
    tg.saveHistory('T_001', h)

    const llm = makeMockLLM(singleRouteJson({ historyStrategy: 'summary_only' }))
    const contexts = await routeAndAssemble('消息', tg, llm, null)

    expect(contexts[0].messages).toHaveLength(0)
  })

  it('连续信号过期后不会走启发式续接', async () => {
    const llm = makeMockLLM(singleRouteJson({ subMessage: '查看 xdev 代码' }))
    const contexts = await routeAndAssemble(
      '把第二项能力展开成 3 条要点',
      tg,
      llm,
      null,
      {
        recentTurns: [{
          topicId: 'T_001',
          userMessage: '上一轮对话',
          assistantReply: '我是艾克斯。三项能力：1. 系统管理 2. 飞书集成 3. 编程与自动化。',
          timestamp: Date.now() - 16 * 60 * 1000,
        }],
      },
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].subMessage).toBe('查看 xdev 代码')
    expect(llm.chatSync).toHaveBeenCalledTimes(1)
  })

  it('会把相关话题摘要和 episodic 经验注入 system prompt', async () => {
    tg.getOrCreate('T_002', 'project_query')
    tg.updateSummary('T_002', 'Workflow 调试与发布状态检查', ['workflow', 'xdev'])

    const memoryManager = {
      searchRelevant: vi.fn().mockResolvedValue([
        { type: 'episodic', content: '处理 workflow 问题时先检查 export-status。', importance: 9 },
        { type: 'semantic', content: '普通事实，不应进入 episodic prompt。', importance: 5 },
      ]),
    } as any

    const llm = makeMockLLM(singleRouteJson({
      relatedTopicIds: ['T_002'],
      entityTags: ['xdev', 'workflow'],
      historyStrategy: 'none',
    }))

    const contexts = await routeAndAssemble('继续看 xdev workflow 的异常', tg, llm, memoryManager)

    expect(memoryManager.searchRelevant).toHaveBeenCalledWith('xdev workflow', 3)
    expect(contexts[0].systemPrompt).toContain('相关话题背景')
    expect(contexts[0].systemPrompt).toContain('Workflow 调试与发布状态检查')
    expect(contexts[0].systemPrompt).toContain('过去类似任务的经验')
    expect(contexts[0].systemPrompt).toContain('先检查 export-status')
    expect(contexts[0].systemPrompt).not.toContain('普通事实，不应进入 episodic prompt')
  })
})
