import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatSessionState } from '../core/chat-session-state'

const realSetTimeout = globalThis.setTimeout

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => realSetTimeout(resolve, ms))
}

describe('chat session integration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('serializes tasks within the same chat', async () => {
    const state = new ChatSessionState()
    const order: string[] = []

    await Promise.all([
      state.enqueue('chat-1', async () => {
        order.push('start-1')
        await sleep(20)
        order.push('end-1')
      }),
      state.enqueue('chat-1', async () => {
        order.push('start-2')
        await sleep(5)
        order.push('end-2')
      }),
    ])

    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('allows different chats to progress independently', async () => {
    const state = new ChatSessionState()
    let secondChatStartedBeforeFirstEnded = false
    let firstChatEnded = false

    await Promise.all([
      state.enqueue('chat-a', async () => {
        await sleep(25)
        firstChatEnded = true
      }),
      state.enqueue('chat-b', async () => {
        secondChatStartedBeforeFirstEnded = !firstChatEnded
      }),
    ])

    expect(secondChatStartedBeforeFirstEnded).toBe(true)
  })

  it('resolves pending clarify replies from the next user message', async () => {
    const state = new ChatSessionState()
    const waiting = state.waitForReply('chat-clarify', 1000)

    expect(state.consumePendingReply('chat-clarify', ' 表格 ')).toBe(true)
    await expect(waiting).resolves.toBe('表格')
  })

  it('times out pending clarify replies when no user response arrives', async () => {
    vi.useFakeTimers()
    const state = new ChatSessionState()
    const waiting = state.waitForReply('chat-timeout', 1000)
    const assertion = expect(waiting).rejects.toThrow('等待用户回复超时')

    await vi.advanceTimersByTimeAsync(1000)

    await assertion
  })
})
