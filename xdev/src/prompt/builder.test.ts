import { describe, expect, it } from 'vitest'
import { createPromptBuilder } from './builder'

describe('createPromptBuilder', () => {
  it('creates isolated builders without leaking memories', () => {
    const first = createPromptBuilder()
    first.setMemories([
      {
        key: 'memory-1',
        value: '用户偏好命令行输出简洁',
        importance: 8,
        timestamp: Date.now(),
      },
    ])

    const second = createPromptBuilder()

    expect(first.build({ includeMemory: true })).toContain('用户偏好命令行输出简洁')
    expect(second.build({ includeMemory: true })).not.toContain('用户偏好命令行输出简洁')
  })

  it('includes the single-chat boundary in the main prompt', () => {
    const prompt = createPromptBuilder().build({ includeMemory: false })

    expect(prompt).toContain('当前阶段只处理飞书单独聊天会话')
    expect(prompt).toContain('默认当前对话是一位用户与艾克斯的一对一私聊')
    expect(prompt).toContain('优先调用 clarify 工具')
    expect(prompt).toContain('xdev doctor / xdev smoke-check / xdev export-status 是 xdev 自己的命令')
  })
})
