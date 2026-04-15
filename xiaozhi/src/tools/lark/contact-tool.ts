import type { Tool, ToolParameterSchema, ToolResult } from '../tool-interface'
import { errorResult, successResult } from '../tool-interface'
import {
  appendNumberFlag,
  appendStringFlag,
  asRecordArray,
  isRecord,
  readString,
  runLarkCli,
} from './runner'

const larkContactSearchUserDefinition = {
  name: 'lark_contact_search_user',
  description:
    '按关键词搜索飞书用户并返回 open_id。适合先查联系人，再配合 IM、日历、任务等飞书工具继续操作。',
  parameters: {
    query: {
      type: 'string' as const,
      description: '搜索关键词，例如姓名、邮箱或手机号片段',
      minLength: 1,
    },
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    page_size: {
      type: 'number' as const,
      description: '最多返回多少个结果，默认 10，最大 50',
      default: 10,
      minimum: 1,
      maximum: 50,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['query'],
  readOnly: true,
}

export function createLarkContactSearchUserTool(): Tool {
  return {
    definition: larkContactSearchUserDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const pageSize =
        typeof params.page_size === 'number' && Number.isFinite(params.page_size)
          ? Math.max(1, Math.min(50, Math.floor(params.page_size)))
          : 10

      if (!query) {
        return errorResult('缺少 query 参数')
      }

      const args = ['contact', '+search-user', '--query', query, '--format', 'json']
      appendStringFlag(args, '--as', identity)
      appendNumberFlag(args, '--page-size', pageSize)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书用户搜索失败: ${result.error}`)
      }

      if (!isRecord(result.parsed)) {
        return errorResult('飞书用户搜索输出格式无效')
      }

      const data = isRecord(result.parsed.data) ? result.parsed.data : null
      const users = asRecordArray(data?.users)

      if (users.length === 0) {
        return successResult(`未找到与 "${query}" 匹配的飞书用户。`, {
          query,
          identity: readString(result.parsed, 'identity') || identity,
          count: 0,
          users: [],
          raw: result.parsed,
        })
      }

      const lines = [`找到 ${users.length} 个飞书用户：`]
      for (const user of users) {
        lines.push(
          `- ${readString(user, 'name') || 'unknown'} (${readString(user, 'open_id') || 'no open_id'})`,
        )
      }

      return successResult(lines.join('\n'), {
        query,
        identity: readString(result.parsed, 'identity') || identity,
        count: users.length,
        users,
        raw: result.parsed,
      })
    },

    validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
      const errors: string[] = []

      if (!params.query || typeof params.query !== 'string' || params.query.trim().length === 0) {
        errors.push('query 参数必须是非空字符串')
      }

      if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
        errors.push('identity 参数必须是 user 或 bot')
      }

      if (params.page_size !== undefined) {
        if (typeof params.page_size !== 'number' || !Number.isFinite(params.page_size)) {
          errors.push('page_size 参数必须是数字')
        } else if (params.page_size < 1 || params.page_size > 50) {
          errors.push('page_size 参数必须在 1 到 50 之间')
        }
      }

      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
    },
  }
}
