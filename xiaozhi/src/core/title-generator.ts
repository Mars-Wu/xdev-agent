// src/core/title-generator.ts
// 会话标题自动生成 — 参考 Hermes agent/title_generator.py（60行）
// 首轮对话完成后异步触发，不阻塞主回复

import { auxChat } from './auxiliary-client'
import { createLogger } from '../utils/logger'

const logger = createLogger('title-gen')

const TITLE_SYSTEM_PROMPT = `你是对话标题生成器。
根据用户的第一条消息和助手的回复，生成一个简短的中文标题（3-8个字）。
标题应概括对话的主要话题或用户意图。
只输出标题文字，不要标点符号、不要引号、不要"标题："前缀。`

/**
 * 生成话题标题（使用辅助模型）
 * 失败时静默返回 null
 */
export async function generateTopicTitle(
  userMessage: string,
  assistantReply: string,
): Promise<string | null> {
  const userSnippet = userMessage.slice(0, 500)
  const replySnippet = assistantReply.slice(0, 500)
  const prompt = `用户: ${userSnippet}\n\n助手: ${replySnippet}`

  const raw = await auxChat(prompt, {
    system: TITLE_SYSTEM_PROMPT,
    maxTokens: 30,
    temperature: 0.3,
  })

  if (!raw) return null

  // 清理：去除首尾引号、"标题:" 前缀
  let title = raw.trim().replace(/^["'"'"']|["'"'"']$/g, '')
  if (/^标题[:：]\s*/i.test(title)) {
    title = title.replace(/^标题[:：]\s*/i, '')
  }
  title = title.replace(/[。，、；：？！,.;:?!]$/, '') // 去尾部标点

  if (title.length > 30) title = title.slice(0, 27) + '...'

  return title || null
}

/**
 * Fire-and-forget 标题生成
 * 只在前2轮用户消息时触发，后续轮次跳过
 *
 * @param updateFn 生成成功后调用（持久化标题）
 */
export function autoGenerateTitle(
  userMessage: string,
  assistantReply: string,
  userMessageCount: number,
  updateFn: (title: string) => void,
): void {
  if (userMessageCount > 2 || !userMessage || !assistantReply) return

  // 不 await，不阻塞当前回复
  setImmediate(async () => {
    const title = await generateTopicTitle(userMessage, assistantReply)
    if (title) {
      try {
        updateFn(title)
        logger.debug(`自动生成话题标题: "${title}"`)
      } catch (err: any) {
        logger.debug(`设置话题标题失败: ${err.message}`)
      }
    }
  })
}
