import { describe, expect, it } from 'vitest'
import { buildOversizeMessageNotice, shouldRejectIncomingMessage } from './message-guard'

describe('message guard', () => {
  it('rejects content longer than the configured limit', () => {
    expect(shouldRejectIncomingMessage('A'.repeat(10001), 10000)).toBe(true)
    expect(shouldRejectIncomingMessage('A'.repeat(10000), 10000)).toBe(false)
  })

  it('builds a readable oversize notice with length, limit, and preview', () => {
    const notice = buildOversizeMessageNotice('ABCDEFGHIJKL', 10, 5)

    expect(notice).toContain('消息过长，已拒绝处理')
    expect(notice).toContain('长度: 12 字符')
    expect(notice).toContain('限制: 10 字符')
    expect(notice).toContain('ABCDE')
  })
})
