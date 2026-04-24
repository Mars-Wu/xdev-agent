import type { ContinuityContext, RecentTurnSignal } from './message-router'

const DEFAULT_MAX_RECENT_TURNS = 2

export class ChatSessionState {
  private readonly pendingClarifyReplies = new Map<string, (text: string) => void>()
  private readonly chatProcessingChains = new Map<string, Promise<void>>()
  private readonly recentChatTurns = new Map<string, RecentTurnSignal[]>()

  constructor(private readonly maxRecentTurns: number = DEFAULT_MAX_RECENT_TURNS) {}

  waitForReply(chatId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClarifyReplies.delete(chatId)
        reject(new Error('等待用户回复超时（60秒）'))
      }, timeoutMs)

      this.pendingClarifyReplies.set(chatId, (text: string) => {
        clearTimeout(timer)
        this.pendingClarifyReplies.delete(chatId)
        resolve(text)
      })
    })
  }

  consumePendingReply(chatId: string, text: string): boolean {
    const resolver = this.pendingClarifyReplies.get(chatId)
    if (!resolver) return false
    resolver(text.trim())
    return true
  }

  getContinuityContext(chatId: string): ContinuityContext | undefined {
    const recentTurns = this.recentChatTurns.get(chatId)
    if (!recentTurns || recentTurns.length === 0) return undefined
    return { recentTurns: [...recentTurns] }
  }

  rememberChatTurn(chatId: string, turn: RecentTurnSignal): void {
    const existing = this.recentChatTurns.get(chatId) || []
    const next = [...existing, turn]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.maxRecentTurns)
    this.recentChatTurns.set(chatId, next)
  }

  enqueue(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chatProcessingChains.get(chatId) || Promise.resolve()
    const nextRun = previous.catch(() => {}).then(task)

    let tracked: Promise<void>
    tracked = nextRun.finally(() => {
      if (this.chatProcessingChains.get(chatId) === tracked) {
        this.chatProcessingChains.delete(chatId)
      }
    })

    this.chatProcessingChains.set(chatId, tracked)
    return tracked
  }
}
