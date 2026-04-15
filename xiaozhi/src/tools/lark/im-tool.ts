import type { Tool, ToolParameterSchema, ToolResult } from '../tool-interface'
import { errorResult, successResult } from '../tool-interface'
import {
  appendBooleanFlag,
  appendNumberFlag,
  appendStringFlag,
  asRecordArray,
  isRecord,
  readNumber,
  readString,
  runLarkCli,
} from './runner'

const larkImSendDefinition = {
  name: 'lark_im_send',
  description:
    '通过 lark-cli 发送飞书消息。适合向指定 chat_id 或用户 open_id 发送文本或 markdown 消息。',
  parameters: {
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    chat_id: {
      type: 'string' as const,
      description: '目标 chat_id（oc_xxx），与 user_id 二选一',
    },
    user_id: {
      type: 'string' as const,
      description: '目标用户 open_id（ou_xxx），与 chat_id 二选一',
    },
    text: {
      type: 'string' as const,
      description: '纯文本消息，与 markdown 二选一',
      minLength: 1,
    },
    markdown: {
      type: 'string' as const,
      description: 'Markdown 消息，与 text 二选一',
      minLength: 1,
    },
    idempotency_key: {
      type: 'string' as const,
      description: '幂等键，可避免重复发送',
    },
  } as Record<string, ToolParameterSchema>,
  readOnly: false,
}

const larkImSearchMessagesDefinition = {
  name: 'lark_im_search_messages',
  description:
    '搜索飞书消息并返回 message_id、chat_id、发送时间和摘要。适合反查会话、定位上下文、确认消息是否发送成功。',
  parameters: {
    query: {
      type: 'string' as const,
      description: '消息搜索关键词',
      minLength: 1,
    },
    chat_id: {
      type: 'string' as const,
      description: '仅在指定 chat_id 内搜索',
    },
    chat_type: {
      type: 'string' as const,
      description: '会话类型过滤',
      enum: ['group', 'p2p'],
    },
    sender: {
      type: 'string' as const,
      description: '发送者 open_id，支持单个或逗号分隔多个',
    },
    sender_type: {
      type: 'string' as const,
      description: '发送者类型过滤',
      enum: ['user', 'bot'],
    },
    start: {
      type: 'string' as const,
      description: '开始时间，ISO 8601 格式',
    },
    end: {
      type: 'string' as const,
      description: '结束时间，ISO 8601 格式',
    },
    page_size: {
      type: 'number' as const,
      description: '每页返回数量，默认 10，最大 50',
      default: 10,
      minimum: 1,
      maximum: 50,
    },
    page_limit: {
      type: 'number' as const,
      description: '最多拉取多少页；大于 1 时会自动翻页，默认 1，最大 20',
      default: 1,
      minimum: 1,
      maximum: 20,
    },
    is_at_me: {
      type: 'boolean' as const,
      description: '是否仅搜索 @我的消息',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['query'],
  readOnly: true,
}

export function createLarkImSendTool(): Tool {
  return {
    definition: larkImSendDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const chatId = typeof params.chat_id === 'string' ? params.chat_id.trim() : ''
      const userId = typeof params.user_id === 'string' ? params.user_id.trim() : ''
      const text = typeof params.text === 'string' ? params.text : ''
      const markdown = typeof params.markdown === 'string' ? params.markdown : ''
      const idempotencyKey =
        typeof params.idempotency_key === 'string' ? params.idempotency_key.trim() : ''

      if (!hasExactlyOne(chatId, userId)) {
        return errorResult('chat_id 和 user_id 必须且只能提供一个')
      }

      if (!hasExactlyOne(text, markdown)) {
        return errorResult('text 和 markdown 必须且只能提供一个')
      }

      const args = ['im', '+messages-send', '--as', identity]
      appendStringFlag(args, '--chat-id', chatId)
      appendStringFlag(args, '--user-id', userId)
      appendStringFlag(args, '--text', text)
      appendStringFlag(args, '--markdown', markdown)
      appendStringFlag(args, '--idempotency-key', idempotencyKey)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书消息发送失败: ${result.error}`)
      }

      if (!isRecord(result.parsed)) {
        return errorResult('飞书消息发送输出格式无效')
      }

      const data = isRecord(result.parsed.data) ? result.parsed.data : null
      const messageId = readString(data, 'message_id') || readString(result.parsed, 'message_id')
      const target = chatId || userId

      const lines = [
        `message sent via ${identity}`,
        `target: ${target}`,
      ]
      if (messageId) {
        lines.push(`message_id: ${messageId}`)
      }

      return successResult(lines.join('\n'), {
        identity,
        target,
        message_id: messageId,
        raw: result.parsed,
      })
    },

    validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
      return validateSendParams(params)
    },
  }
}

export function createLarkImSearchMessagesTool(): Tool {
  return {
    definition: larkImSearchMessagesDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      const chatId = typeof params.chat_id === 'string' ? params.chat_id.trim() : ''
      const chatType =
        params.chat_type === 'group' || params.chat_type === 'p2p' ? params.chat_type : undefined
      const sender = typeof params.sender === 'string' ? params.sender.trim() : ''
      const senderType =
        params.sender_type === 'user' || params.sender_type === 'bot'
          ? params.sender_type
          : undefined
      const start = typeof params.start === 'string' ? params.start.trim() : ''
      const end = typeof params.end === 'string' ? params.end.trim() : ''
      const pageSize =
        typeof params.page_size === 'number' && Number.isFinite(params.page_size)
          ? Math.max(1, Math.min(50, Math.floor(params.page_size)))
          : 10
      const pageLimit =
        typeof params.page_limit === 'number' && Number.isFinite(params.page_limit)
          ? Math.max(1, Math.min(20, Math.floor(params.page_limit)))
          : 1
      const isAtMe = params.is_at_me === true

      if (!query) {
        return errorResult('缺少 query 参数')
      }

      const args = [
        'im',
        '+messages-search',
        '--as',
        'user',
        '--format',
        'json',
        '--query',
        query,
      ]
      appendStringFlag(args, '--chat-id', chatId)
      appendStringFlag(args, '--chat-type', chatType)
      appendStringFlag(args, '--sender', sender)
      appendStringFlag(args, '--sender-type', senderType)
      appendStringFlag(args, '--start', start)
      appendStringFlag(args, '--end', end)
      appendNumberFlag(args, '--page-size', pageSize)
      appendBooleanFlag(args, '--is-at-me', isAtMe)
      if (pageLimit > 1) {
        appendBooleanFlag(args, '--page-all', true)
        appendNumberFlag(args, '--page-limit', pageLimit)
      }

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书消息搜索失败: ${result.error}`)
      }

      if (!isRecord(result.parsed)) {
        return errorResult('飞书消息搜索输出格式无效')
      }

      const data = isRecord(result.parsed.data) ? result.parsed.data : null
      const messages = asRecordArray(data?.messages)
      const total = readNumber(data, 'total') ?? messages.length
      const hasMore = data?.has_more === true

      if (messages.length === 0) {
        return successResult(`未找到与 "${query}" 匹配的飞书消息。`, {
          query,
          count: 0,
          total,
          messages: [],
          raw: result.parsed,
        })
      }

      const lines = [`找到 ${messages.length} 条飞书消息（total=${total}${hasMore ? ', has_more=yes' : ''}）：`]
      for (const message of messages.slice(0, 10)) {
        lines.push(
          `- [${readString(message, 'create_time') || 'unknown'}] ${
            sanitizeMessageSnippet(readString(message, 'content'))
          } (message_id=${readString(message, 'message_id') || 'unknown'}, chat_id=${readString(message, 'chat_id') || 'unknown'})`,
        )
      }

      return successResult(lines.join('\n'), {
        query,
        count: messages.length,
        total,
        has_more: hasMore,
        messages,
        raw: result.parsed,
      })
    },

    validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
      const errors: string[] = []

      if (!params.query || typeof params.query !== 'string' || params.query.trim().length === 0) {
        errors.push('query 参数必须是非空字符串')
      }

      if (params.chat_type !== undefined && params.chat_type !== 'group' && params.chat_type !== 'p2p') {
        errors.push('chat_type 参数必须是 group 或 p2p')
      }

      if (params.sender_type !== undefined && params.sender_type !== 'user' && params.sender_type !== 'bot') {
        errors.push('sender_type 参数必须是 user 或 bot')
      }

      if (params.page_size !== undefined) {
        if (typeof params.page_size !== 'number' || !Number.isFinite(params.page_size)) {
          errors.push('page_size 参数必须是数字')
        } else if (params.page_size < 1 || params.page_size > 50) {
          errors.push('page_size 参数必须在 1 到 50 之间')
        }
      }

      if (params.page_limit !== undefined) {
        if (typeof params.page_limit !== 'number' || !Number.isFinite(params.page_limit)) {
          errors.push('page_limit 参数必须是数字')
        } else if (params.page_limit < 1 || params.page_limit > 20) {
          errors.push('page_limit 参数必须在 1 到 20 之间')
        }
      }

      if (params.is_at_me !== undefined && typeof params.is_at_me !== 'boolean') {
        errors.push('is_at_me 参数必须是布尔值')
      }

      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
    },
  }
}

function hasExactlyOne(first: string, second: string): boolean {
  return Number(Boolean(first)) + Number(Boolean(second)) === 1
}

function sanitizeMessageSnippet(content?: string): string {
  if (!content) {
    return '(empty)'
  }

  return content.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty)'
}

function validateSendParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  const hasChatId = typeof params.chat_id === 'string' && params.chat_id.trim().length > 0
  const hasUserId = typeof params.user_id === 'string' && params.user_id.trim().length > 0
  if (Number(hasChatId) + Number(hasUserId) !== 1) {
    errors.push('chat_id 和 user_id 必须且只能提供一个')
  }

  const hasText = typeof params.text === 'string' && params.text.length > 0
  const hasMarkdown = typeof params.markdown === 'string' && params.markdown.length > 0
  if (Number(hasText) + Number(hasMarkdown) !== 1) {
    errors.push('text 和 markdown 必须且只能提供一个')
  }

  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}
