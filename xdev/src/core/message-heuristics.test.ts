import { describe, expect, it } from 'vitest'
import {
  detectStructuredClarifyPrompt,
  hasStrongFollowUpHint,
  rewriteFollowUpWithRecentReply,
  rewriteStructuredClarifyResolution,
  splitExplicitSubQuestions,
} from './message-heuristics'

describe('message heuristics', () => {
  it('detects strong follow-up hints for ordinal references', () => {
    expect(hasStrongFollowUpHint('把第二项能力展开成 3 条要点')).toBe(true)
  })

  it('rewrites follow-up messages with the previous reply', () => {
    const rewritten = rewriteFollowUpWithRecentReply(
      '把第二项能力展开成 3 条要点',
      '三项核心能力：1. 系统管理 2. 飞书集成 3. 编程与自动化',
    )

    expect(rewritten).toContain('上一轮助手回复如下')
    expect(rewritten).toContain('第二项能力')
    expect(rewritten).toContain('飞书集成')
  })

  it('splits explicitly enumerated sub-questions', () => {
    expect(
      splitExplicitSubQuestions('请分别回答两件事：第一，xdev doctor 是做什么的；第二，workflow 工具支持哪些阶段化能力。'),
    ).toEqual([
      'xdev doctor 是做什么的',
      'workflow 工具支持哪些阶段化能力。',
    ])
  })

  it('detects structured clarify prompts from explicit indecision', () => {
    expect(
      detectStructuredClarifyPrompt('帮我在飞书里创建一个东西，我还没决定是文档、表格还是多维表。'),
    ).toEqual({
      question: '你希望我创建哪一种？',
      choices: ['文档', '表格', '多维表'],
    })
  })

  it('rewrites clarified requests so the resolved choice becomes binding context', () => {
    const rewritten = rewriteStructuredClarifyResolution(
      '帮我在飞书里创建一个东西，我还没决定是文档、表格还是多维表。',
      '表格',
    )

    expect(rewritten).toContain('用户已明确选择：表格')
    expect(rewritten).toContain('不要再次在候选项之间追问')
  })
})
