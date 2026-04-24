import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLarkCli } from './runner'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock('child_process', () => ({
  spawn: spawnMock,
}))

describe('runLarkCli', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('parses JSON output on success', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: JSON.stringify({ ok: true, data: { message_id: 'om_123' } }),
      }),
    )

    const result = await runLarkCli(['im', '+messages-send'], { parseMode: 'json' })

    expect(result.ok).toBe(true)
    expect(result.parsed).toEqual({ ok: true, data: { message_id: 'om_123' } })
  })

  it('falls back to text in auto mode', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: 'plain text output',
      }),
    )

    const result = await runLarkCli(['doctor'], { parseMode: 'auto' })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('plain text output')
    expect(result.parsed).toBeUndefined()
  })

  it('parses dry-run wrapped JSON output', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        stdout: '=== Dry Run ===\n{"mcp_tool":"create-doc","args":{"title":"Test"}}',
      }),
    )

    const result = await runLarkCli(['docs', '+create'], { parseMode: 'json' })

    expect(result.ok).toBe(true)
    expect(result.parsed).toEqual({ mcp_tool: 'create-doc', args: { title: 'Test' } })
  })

  it('treats ok=false JSON payload as failure', async () => {
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

    const result = await runLarkCli(['calendar', '+agenda'], { parseMode: 'json' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('missing required scope')
  })

  it('returns stderr when command exits non-zero', async () => {
    spawnMock.mockReturnValueOnce(
      createMockProcess({
        exitCode: 1,
        stderr: 'permission denied',
      }),
    )

    const result = await runLarkCli(['contact', '+search-user'], { parseMode: 'json' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('permission denied')
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
