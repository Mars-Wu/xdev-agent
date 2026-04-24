import { spawn } from 'child_process'
import { createLogger } from '../../utils/logger'

const logger = createLogger('lark-cli-runner')
const DEFAULT_TIMEOUT_MS = 30000

export type LarkCliIdentity = 'user' | 'bot'
export type LarkCliParseMode = 'json' | 'auto' | 'text'

export interface LarkCliRunOptions {
  cwd?: string
  timeoutMs?: number
  parseMode?: LarkCliParseMode
}

export interface LarkCliRunResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  text: string
  parsed?: unknown
  error?: string
  timedOut?: boolean
}

export function appendBooleanFlag(args: string[], flag: string, value?: boolean): void {
  if (value) {
    args.push(flag)
  }
}

export function appendStringFlag(args: string[], flag: string, value?: string): void {
  if (value) {
    args.push(flag, value)
  }
}

export function appendNumberFlag(args: string[], flag: string, value?: number): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    args.push(flag, String(value))
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord)
}

export function readString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

export function readBoolean(record: Record<string, unknown> | null | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

export function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' ? value : undefined
}

export async function runLarkCli(
  args: string[],
  options: LarkCliRunOptions = {},
): Promise<LarkCliRunResult> {
  const parseMode = options.parseMode || 'json'
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS

  logger.debug(`执行 lark-cli: ${args.join(' ')}`)

  return new Promise<LarkCliRunResult>((resolve) => {
    const proc = spawn('lark-cli', args, {
      cwd: options.cwd,
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (error: Error) => {
      clearTimeout(timeoutHandle)
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        text: stdout.trim() || stderr.trim(),
        error: `无法启动 lark-cli: ${error.message}`,
      })
    })

    proc.on('close', (exitCode: number | null) => {
      clearTimeout(timeoutHandle)

      const trimmedStdout = stdout.trim()
      const trimmedStderr = stderr.trim()
      const text = trimmedStdout || trimmedStderr

      if (timedOut) {
        resolve({
          ok: false,
          exitCode,
          stdout,
          stderr,
          text,
          error: `lark-cli 命令超时（${timeoutMs}ms）`,
          timedOut: true,
        })
        return
      }

      if ((exitCode ?? 0) !== 0) {
        const parsed = parseJson(trimmedStdout) ?? parseJson(trimmedStderr)
        resolve({
          ok: false,
          exitCode,
          stdout,
          stderr,
          text,
          parsed: parsed?.value,
          error:
            extractCliError(parsed?.value) ||
            trimmedStderr ||
            trimmedStdout ||
            `lark-cli 命令退出码 ${exitCode}`,
        })
        return
      }

      if (parseMode === 'text') {
        resolve({
          ok: true,
          exitCode,
          stdout,
          stderr,
          text,
        })
        return
      }

      const parsed = parseJson(trimmedStdout)
      if (parsed) {
        if (isCliPayloadFailure(parsed.value)) {
          resolve({
            ok: false,
            exitCode,
            stdout,
            stderr,
            text,
            parsed: parsed.value,
            error: extractCliError(parsed.value) || 'lark-cli 返回失败结果',
          })
          return
        }

        resolve({
          ok: true,
          exitCode,
          stdout,
          stderr,
          text,
          parsed: parsed.value,
        })
        return
      }

      if (parseMode === 'auto') {
        resolve({
          ok: true,
          exitCode,
          stdout,
          stderr,
          text,
        })
        return
      }

      resolve({
        ok: false,
        exitCode,
        stdout,
        stderr,
        text,
        error: 'lark-cli 输出不是合法 JSON',
      })
    })
  })
}

function parseJson(raw: string): { value: unknown } | null {
  if (!raw) {
    return null
  }

  for (const candidate of buildJsonCandidates(raw)) {
    try {
      return { value: JSON.parse(candidate) }
    } catch {
      continue
    }
  }

  return null
}

function buildJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const braceIndex = trimmed.indexOf('{')
  const bracketIndex = trimmed.indexOf('[')

  for (const index of [braceIndex, bracketIndex]) {
    if (index > 0) {
      candidates.push(trimmed.slice(index))
    }
  }

  return Array.from(new Set(candidates.filter(Boolean)))
}

function isCliPayloadFailure(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false
  }

  return readBoolean(payload, 'ok') === false
}

function extractCliError(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const direct =
    readString(payload, 'error') ||
    readString(payload, 'message') ||
    readString(payload, 'msg')
  if (direct) {
    return direct
  }

  const nestedError = payload.error
  if (isRecord(nestedError)) {
    const message = readString(nestedError, 'message')
    const hint = readString(nestedError, 'hint')
    const type = readString(nestedError, 'type')

    if (message && hint) {
      return `${message} (${hint})`
    }
    if (message && type) {
      return `${message} [${type}]`
    }
    if (message) {
      return message
    }
    if (hint) {
      return hint
    }
    if (type) {
      return type
    }
  }

  const data = payload.data
  if (!isRecord(data)) {
    return undefined
  }

  return readString(data, 'error') || readString(data, 'message') || readString(data, 'msg')
}
