import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSessionState } from '../core/chat-session-state'
import { routeAndAssemble } from '../core/message-router'
import { MessageHistoryManager } from '../core/message-history'
import { TopicGraph } from '../storage/topic-graph'

function makeTempGraph(): { tg: TopicGraph; tmpDir: string } {
  const tmpDir = path.join(os.tmpdir(), `xdev-topic-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tg = new TopicGraph(path.join(tmpDir, 'index.db'))
  tg.init()
  return { tg, tmpDir }
}

describe('topic history integration', () => {
  let tg: TopicGraph
  let tmpDir: string

  beforeEach(() => {
    ;({ tg, tmpDir } = makeTempGraph())
  })

  afterEach(() => {
    tg.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('uses remembered recent turns plus persisted topic history for follow-up expansion', async () => {
    const state = new ChatSessionState()
    tg.getOrCreate('T_capability', 'general_chat')
    tg.updateSummary('T_capability', '介绍艾克斯三项核心能力', ['xdev'])

    const history = new MessageHistoryManager()
    history.addMessage({ role: 'user', content: '请介绍艾克斯的三项核心能力。' })
    history.addMessage({ role: 'assistant', content: '三项核心能力：1. 系统管理 2. 飞书集成 3. 编程与自动化。' })
    tg.saveHistory('T_capability', history)

    state.rememberChatTurn('chat-1', {
      topicId: 'T_capability',
      userMessage: '请介绍艾克斯的三项核心能力。',
      assistantReply: '三项核心能力：1. 系统管理 2. 飞书集成 3. 编程与自动化。',
      timestamp: Date.now(),
    })

    const llm = { chatSync: vi.fn() } as any
    const contexts = await routeAndAssemble(
      '把第二项能力展开成 3 条要点，并尽量结合当前 xdev 项目。',
      tg,
      llm,
      null,
      state.getContinuityContext('chat-1'),
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].topicId).toBe('T_capability')
    expect(contexts[0].messages).toHaveLength(2)
    expect(contexts[0].subMessage).toContain('上一轮助手回复如下')
    expect(contexts[0].subMessage).toContain('飞书集成')
    expect(llm.chatSync).not.toHaveBeenCalled()
  })

  it('keeps interleaved topics isolated by following the latest remembered topic', async () => {
    const state = new ChatSessionState()

    tg.getOrCreate('T_doctor', 'project_query')
    tg.updateSummary('T_doctor', 'xdev doctor 诊断命令说明', ['xdev', 'doctor'])
    const doctorHistory = new MessageHistoryManager()
    doctorHistory.addMessage({ role: 'user', content: 'xdev doctor 是做什么的？' })
    doctorHistory.addMessage({ role: 'assistant', content: '它会检查模型、飞书和工具链状态。' })
    tg.saveHistory('T_doctor', doctorHistory)

    tg.getOrCreate('T_workflow', 'project_query')
    tg.updateSummary('T_workflow', 'workflow 阶段和 pass criteria 设计', ['workflow'])
    const workflowHistory = new MessageHistoryManager()
    workflowHistory.addMessage({ role: 'user', content: 'workflow 工具支持哪些阶段化能力？' })
    workflowHistory.addMessage({ role: 'assistant', content: '支持阶段、pass criteria、checkpoint 与 resume。' })
    tg.saveHistory('T_workflow', workflowHistory)

    state.rememberChatTurn('chat-2', {
      topicId: 'T_doctor',
      userMessage: 'xdev doctor 是做什么的？',
      assistantReply: '它会检查模型、飞书和工具链状态。',
      timestamp: Date.now() - 60_000,
    })
    state.rememberChatTurn('chat-2', {
      topicId: 'T_workflow',
      userMessage: 'workflow 工具支持哪些阶段化能力？',
      assistantReply: '支持阶段、pass criteria、checkpoint 与 resume。',
      timestamp: Date.now(),
    })

    const llm = { chatSync: vi.fn() } as any
    const contexts = await routeAndAssemble(
      '把这个阶段化能力再细说一下，尤其是 checkpoint 和 resume。',
      tg,
      llm,
      null,
      state.getContinuityContext('chat-2'),
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].topicId).toBe('T_workflow')
    expect(contexts[0].messages.map(message => message.content)).toContain('支持阶段、pass criteria、checkpoint 与 resume。')
    expect(contexts[0].messages.map(message => message.content)).not.toContain('它会检查模型、飞书和工具链状态。')
    expect(contexts[0].subMessage).toContain('checkpoint 和 resume')
  })
})
