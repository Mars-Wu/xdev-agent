import type { Tool, ToolParameterSchema, ToolResult } from '../tool-interface'
import { errorResult, successResult } from '../tool-interface'
import {
  appendBooleanFlag,
  appendNumberFlag,
  appendStringFlag,
  asRecordArray,
  isRecord,
  readString,
  runLarkCli,
} from './runner'

const larkCalendarAgendaDefinition = {
  name: 'lark_calendar_agenda',
  description:
    '查看日程安排。适合读取某个时间范围内的 agenda 作为工作摘要或会议上下文。',
  parameters: {
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    calendar_id: {
      type: 'string' as const,
      description: '日历 ID，默认 primary',
    },
    start: {
      type: 'string' as const,
      description: '开始时间，ISO 8601',
    },
    end: {
      type: 'string' as const,
      description: '结束时间，ISO 8601',
    },
  } as Record<string, ToolParameterSchema>,
  readOnly: true,
}

const larkCalendarFreebusyDefinition = {
  name: 'lark_calendar_freebusy',
  description:
    '查询用户忙闲状态和 RSVP 结果。适合安排会议前确认时间段是否空闲。',
  parameters: {
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    user_id: {
      type: 'string' as const,
      description: '目标用户 open_id，默认当前用户',
    },
    start: {
      type: 'string' as const,
      description: '开始时间，ISO 8601',
    },
    end: {
      type: 'string' as const,
      description: '结束时间，ISO 8601',
    },
  } as Record<string, ToolParameterSchema>,
  readOnly: true,
}

const larkCalendarCreateDefinition = {
  name: 'lark_calendar_create',
  description:
    '创建飞书日程，可指定标题、时间、描述和参会人。适合由小智代为发起会议或提醒事项。',
  parameters: {
    identity: {
      type: 'string' as const,
      description: '调用身份，默认 user',
      enum: ['user', 'bot'],
      default: 'user',
    },
    calendar_id: {
      type: 'string' as const,
      description: '日历 ID，默认 primary',
    },
    summary: {
      type: 'string' as const,
      description: '日程标题',
      minLength: 1,
    },
    start: {
      type: 'string' as const,
      description: '开始时间，ISO 8601',
      minLength: 1,
    },
    end: {
      type: 'string' as const,
      description: '结束时间，ISO 8601',
      minLength: 1,
    },
    description: {
      type: 'string' as const,
      description: '日程描述',
    },
    attendee_ids: {
      type: 'array' as const,
      description: '参会人 ID 列表，支持用户 ou_、群 oc_、会议室 omm_',
      items: { type: 'string' as const },
    },
    rrule: {
      type: 'string' as const,
      description: '循环规则（RFC5545）',
    },
    dry_run: {
      type: 'boolean' as const,
      description: '仅输出将调用的 CLI 请求，不实际执行',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  required: ['summary', 'start', 'end'],
  readOnly: false,
}

export function createLarkCalendarAgendaTool(): Tool {
  return {
    definition: larkCalendarAgendaDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const calendarId =
        typeof params.calendar_id === 'string' && params.calendar_id.trim()
          ? params.calendar_id.trim()
          : 'primary'
      const start = typeof params.start === 'string' ? params.start.trim() : ''
      const end = typeof params.end === 'string' ? params.end.trim() : ''

      const args = ['calendar', '+agenda', '--as', identity, '--calendar-id', calendarId, '--format', 'json']
      appendStringFlag(args, '--start', start)
      appendStringFlag(args, '--end', end)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书日程查询失败: ${result.error}`)
      }

      return successResult(formatCalendarListing('agenda', result.parsed), {
        calendar_id: calendarId,
        raw: result.parsed,
      })
    },

    validateParams: validateCalendarReadParams,
  }
}

export function createLarkCalendarFreebusyTool(): Tool {
  return {
    definition: larkCalendarFreebusyDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const userId = typeof params.user_id === 'string' ? params.user_id.trim() : ''
      const start = typeof params.start === 'string' ? params.start.trim() : ''
      const end = typeof params.end === 'string' ? params.end.trim() : ''

      const args = ['calendar', '+freebusy', '--as', identity, '--format', 'json']
      appendStringFlag(args, '--user-id', userId)
      appendStringFlag(args, '--start', start)
      appendStringFlag(args, '--end', end)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书忙闲查询失败: ${result.error}`)
      }

      return successResult(formatCalendarListing('freebusy', result.parsed), {
        user_id: userId || undefined,
        raw: result.parsed,
      })
    },

    validateParams: validateCalendarReadParams,
  }
}

export function createLarkCalendarCreateTool(): Tool {
  return {
    definition: larkCalendarCreateDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const identity = params.identity === 'bot' ? 'bot' : 'user'
      const calendarId =
        typeof params.calendar_id === 'string' && params.calendar_id.trim()
          ? params.calendar_id.trim()
          : 'primary'
      const summary = typeof params.summary === 'string' ? params.summary.trim() : ''
      const start = typeof params.start === 'string' ? params.start.trim() : ''
      const end = typeof params.end === 'string' ? params.end.trim() : ''
      const description = typeof params.description === 'string' ? params.description : ''
      const attendeeIds = Array.isArray(params.attendee_ids)
        ? params.attendee_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      const rrule = typeof params.rrule === 'string' ? params.rrule.trim() : ''
      const dryRun = params.dry_run === true

      if (!summary || !start || !end) {
        return errorResult('summary、start、end 参数不能为空')
      }

      const args = [
        'calendar',
        '+create',
        '--as',
        identity,
        '--calendar-id',
        calendarId,
        '--summary',
        summary,
        '--start',
        start,
        '--end',
        end,
      ]
      appendStringFlag(args, '--description', description)
      appendStringFlag(args, '--attendee-ids', attendeeIds.join(','))
      appendStringFlag(args, '--rrule', rrule)
      appendBooleanFlag(args, '--dry-run', dryRun)

      const result = await runLarkCli(args, { parseMode: 'json' })
      if (!result.ok) {
        return errorResult(`飞书日程创建失败: ${result.error}`)
      }

      const output = dryRun
        ? 'dry run prepared for calendar create'
        : formatCalendarMutation(summary, start, end, result.parsed)

      return successResult(output, {
        calendar_id: calendarId,
        attendee_ids: attendeeIds,
        dry_run: dryRun,
        raw: result.parsed,
      })
    },

    validateParams: validateCalendarCreateParams,
  }
}

function validateCalendarReadParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }

  for (const key of ['calendar_id', 'user_id', 'start', 'end']) {
    if (params[key] !== undefined && typeof params[key] !== 'string') {
      errors.push(`${key} 参数必须是字符串`)
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}

function validateCalendarCreateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
  const errors: string[] = []

  if (!params.summary || typeof params.summary !== 'string' || params.summary.trim().length === 0) {
    errors.push('summary 参数必须是非空字符串')
  }
  if (!params.start || typeof params.start !== 'string' || params.start.trim().length === 0) {
    errors.push('start 参数必须是非空字符串')
  }
  if (!params.end || typeof params.end !== 'string' || params.end.trim().length === 0) {
    errors.push('end 参数必须是非空字符串')
  }
  if (params.identity !== undefined && params.identity !== 'user' && params.identity !== 'bot') {
    errors.push('identity 参数必须是 user 或 bot')
  }
  if (params.attendee_ids !== undefined) {
    if (!Array.isArray(params.attendee_ids) || params.attendee_ids.some((value) => typeof value !== 'string')) {
      errors.push('attendee_ids 参数必须是字符串数组')
    }
  }
  if (params.dry_run !== undefined && typeof params.dry_run !== 'boolean') {
    errors.push('dry_run 参数必须是布尔值')
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
}

function formatCalendarListing(kind: 'agenda' | 'freebusy', payload: unknown): string {
  if (!isRecord(payload)) {
    return `calendar ${kind} retrieved`
  }

  const data = isRecord(payload.data) ? payload.data : payload
  const items = extractCalendarItems(data)
  if (items.length === 0) {
    return `calendar ${kind} retrieved`
  }

  const lines = [`calendar ${kind} returned ${items.length} item(s):`]
  for (const item of items.slice(0, 10)) {
    lines.push(
      `- ${readString(item, 'summary') || readString(item, 'title') || readString(item, 'status') || 'item'} (${readString(item, 'start_time') || readString(item, 'start') || 'unknown'} -> ${readString(item, 'end_time') || readString(item, 'end') || 'unknown'})`,
    )
  }
  return lines.join('\n')
}

function extractCalendarItems(data: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ['items', 'events', 'calendars', 'freebusy', 'busy_slots', 'attendees']) {
    const list = asRecordArray(data[key])
    if (list.length > 0) {
      return list
    }
  }

  return []
}

function formatCalendarMutation(summary: string, start: string, end: string, payload: unknown): string {
  if (!isRecord(payload)) {
    return `日程已创建：${summary} (${start} -> ${end})`
  }

  const data = isRecord(payload.data) ? payload.data : payload
  const eventId =
    readString(data, 'event_id') ||
    readString(data, 'id')
  const url = readString(data, 'url') || readString(data, 'event_url')

  const lines = [`日程已创建：${summary} (${start} -> ${end})`]
  if (eventId) {
    lines.push(`event_id: ${eventId}`)
  }
  if (url) {
    lines.push(`url: ${url}`)
  }
  return lines.join('\n')
}
