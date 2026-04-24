export interface StructuredClarifyPrompt {
  question: string
  choices: string[]
}

const FOLLOW_UP_REFERENCE_RE = /(刚才|刚刚|继续|接着|这个|那个|它|上一条|上一个|前面|刚才那条|刚才那个|刚刚那个|再说|继续说|继续看|上面|前一个|第[一二三四五六七八九十0-9]+(?:项|点|条|部分|个)?|这(?:一)?(?:项|点|条|部分)|那(?:一)?(?:项|点|条|部分)|展开|细说|详细说说|补充一下)/

const CLARIFY_INTENT_RE = /(没决定|还没决定|不确定|没想好|还没想好|拿不准|不清楚|未决定)/
const CREATE_INTENT_RE = /(创建|新建|做一个|建一个|生成一个)/

export function hasStrongFollowUpHint(message: string): boolean {
  return FOLLOW_UP_REFERENCE_RE.test(message.trim())
}

export function rewriteFollowUpWithRecentReply(
  message: string,
  assistantReply: string,
): string | null {
  const compactMessage = message.trim()
  const compactReply = assistantReply.trim()
  if (!compactMessage || !compactReply || !hasStrongFollowUpHint(compactMessage)) {
    return null
  }

  return [
    '上一轮助手回复如下：',
    compactReply,
    '',
    `请直接基于上一轮被引用的内容，继续回答这个问题：${compactMessage}`,
  ].join('\n')
}

export function splitExplicitSubQuestions(message: string): string[] {
  const normalized = message.trim().replace(/\s+/g, ' ')
  if (
    !/(分别回答|分别说明|分别介绍|依次回答|逐一回答|两件事|两个问题|两个方面|两部分)/.test(normalized)
    || !/第[一二三四五六七八九十0-9]/.test(normalized)
  ) {
    return []
  }

  const matches = Array.from(normalized.matchAll(/第([一二三四五六七八九十0-9]+)[、，,:：]?\s*/g))
  if (matches.length < 2) return []

  const parts: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const start = (current.index ?? 0) + current[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length
    const segment = normalized
      .slice(start, end)
      .replace(/^[；;，,\s]+/, '')
      .replace(/[；;，,\s]+$/, '')
      .trim()

    if (segment) {
      parts.push(segment)
    }
  }

  return parts.slice(0, 3)
}

export function detectStructuredClarifyPrompt(message: string): StructuredClarifyPrompt | null {
  const normalized = message.trim()
  if (!normalized || !CLARIFY_INTENT_RE.test(normalized)) {
    return null
  }

  const tail = normalized
    .split(CLARIFY_INTENT_RE)
    .pop()
    ?.replace(/[。？！].*$/, '')
    ?.replace(/^[^是]*是/, '')
    ?.trim()

  if (!tail || !/(还是|或|、)/.test(tail)) {
    return null
  }

  const choices = tail
    .split(/还是|或|、|\//)
    .map(part => part.replace(/^[,，\s]+|[,，\s]+$/g, '').trim())
    .filter(Boolean)
    .filter(part => part.length <= 12)
    .filter((part, index, array) => array.indexOf(part) === index)

  if (choices.length < 2 || choices.length > 4) {
    return null
  }

  const question = CREATE_INTENT_RE.test(normalized)
    ? '你希望我创建哪一种？'
    : '你希望我按哪一种理解并继续？'

  return { question, choices }
}

export function rewriteStructuredClarifyResolution(message: string, choice: string): string {
  const normalizedMessage = message.trim()
  const normalizedChoice = choice.trim()

  if (!normalizedMessage || !normalizedChoice) {
    return message
  }

  return [
    `原始请求：${normalizedMessage}`,
    `用户已明确选择：${normalizedChoice}`,
    `请将“${normalizedChoice}”视为已确认选项，直接基于这个选择继续处理。若仍缺少标题、用途或范围等必要信息，只询问这些剩余信息，不要再次在候选项之间追问。`,
  ].join('\n')
}
