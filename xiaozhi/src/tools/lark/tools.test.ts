import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLarkAuthStatusTool } from './auth-tool'
import {
  createLarkCalendarAgendaTool,
  createLarkCalendarCreateTool,
} from './calendar-tool'
import { createLarkContactSearchUserTool } from './contact-tool'
import { createLarkDocsCreateTool, createLarkDocsSearchTool, createLarkDocsUpdateTool } from './docs-tool'
import { createLarkImSearchMessagesTool, createLarkImSendTool } from './im-tool'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

describe('lark tools', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('combines auth status and doctor results', async () => {
    spawnMock
      .mockReturnValueOnce(
        createMockProcess({
          stdout: JSON.stringify({
            identity: 'user',
            userName: '武晓宇',
            userOpenId: 'ou_123',
            tokenStatus: 'valid',
            verified: true,
            scope: 'im:message',
          }),
        }),
      )
      .mockReturnValueOnce(
        createMockProcess({
          stdout: JSON.stringify({
            ok: true,
            checks: [{ name: 'token_verified', status: 'pass', message: 'ok' }],
          }),
        }),
      )

    const result = await createLarkAuthStatusTool().execute({})

    expect(result.success).toBe(true)
    expect(result.output).toContain('identity: user')
    expect(result.output).toContain('doctor_ok: yes')
  })

  it('searches contacts and summarizes users', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({
          ok: true,
          identity: 'user',
          data: {
            users: [
              { name: '武晓宇', open_id: 'ou_123' },
              { name: '小智', open_id: 'ou_456' },
            ],
          },
        }),
      }),
    )

    const result = await createLarkContactSearchUserTool().execute({ query: '武' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('武晓宇')
    expect(result.output).toContain('小智')
  })

  it('sends messages with structured recipient args', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({
          ok: true,
          data: {
            message_id: 'om_789',
          },
        }),
      }),
    )

    const tool = createLarkImSendTool()
    const result = await tool.execute({
      identity: 'user',
      chat_id: 'oc_123',
      text: 'hello',
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('target: oc_123')
    expect(result.output).toContain('message_id: om_789')
    expect(spawnMock).toHaveBeenCalledWith(
      'lark-cli',
      ['im', '+messages-send', '--as', 'user', '--chat-id', 'oc_123', '--text', 'hello'],
      expect.any(Object),
    )
  })

  it('searches messages and returns summaries', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({
          ok: true,
          data: {
            total: 1,
            messages: [
              {
                create_time: '2026-04-14 09:19',
                content: '收到！消息链路正常 ✅',
                message_id: 'om_123',
                chat_id: 'oc_456',
              },
            ],
          },
        }),
      }),
    )

    const result = await createLarkImSearchMessagesTool().execute({
      query: '收到',
      page_size: 5,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('om_123')
    expect(result.output).toContain('oc_456')
  })

  it('searches docs and summarizes results', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({
          ok: true,
          data: {
            total: 1,
            results: [
              {
                title_highlighted: '飞书CLI使用说明',
                result_meta: {
                  doc_types: 'DOCX',
                  token: 'doc_token_123',
                },
              },
            ],
          },
        }),
      }),
    )

    const result = await createLarkDocsSearchTool().execute({ query: '飞书CLI' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('飞书CLI使用说明')
    expect(result.output).toContain('doc_token_123')
  })

  it('supports docs create dry-run output', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: '=== Dry Run ===\n{"mcp_tool":"create-doc","args":{"title":"Test"}}',
      }),
    )

    const result = await createLarkDocsCreateTool().execute({
      title: 'Test',
      markdown: '# body',
      dry_run: true,
    })

    expect(result.success).toBe(true)
    expect(result.output).toContain('dry run prepared for create-doc')
  })

  it('rejects docs replace_range without selector', () => {
    const validation = createLarkDocsUpdateTool().validateParams?.({
      doc: 'https://www.feishu.cn/docx/abc',
      mode: 'replace_range',
      markdown: 'body',
    })

    expect(validation?.valid).toBe(false)
    expect(validation?.errors?.join('\n')).toContain('replace_range 模式必须提供')
  })

  it('surfaces missing calendar scope errors', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({
          ok: false,
          error: {
            type: 'missing_scope',
            message: 'missing required scope(s): calendar:calendar.event:read',
          },
        }),
      }),
    )

    const result = await createLarkCalendarAgendaTool().execute({})

    expect(result.success).toBe(false)
    expect(result.error).toContain('missing required scope')
  })

  it('joins attendee ids for calendar creation', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({
          ok: true,
          data: {
            event_id: 'evt_123',
          },
        }),
      }),
    )

    const result = await createLarkCalendarCreateTool().execute({
      summary: 'Sync',
      start: '2026-04-15T10:00:00+08:00',
      end: '2026-04-15T10:30:00+08:00',
      attendee_ids: ['ou_1', 'oc_2'],
    })

    expect(result.success).toBe(true)
    expect(spawnMock).toHaveBeenCalledWith(
      'lark-cli',
      expect.arrayContaining(['--attendee-ids', 'ou_1,oc_2']),
      expect.any(Object),
    )
  })
})

function createMockProcess(options: { stdout?: string; stderr?: string; exitCode?: number | null }) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }

  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()

  process.nextTick(() => {
    if (options.stdout) {
      proc.stdout.emit('data', Buffer.from(options.stdout))
    }
    if (options.stderr) {
      proc.stderr.emit('data', Buffer.from(options.stderr))
    }
    proc.emit('close', options.exitCode ?? 0)
  })

  return proc
}
