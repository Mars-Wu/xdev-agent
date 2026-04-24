import type { Tool, ToolResult, ToolParameterSchema } from '../tool-interface'
import { errorResult, successResult } from '../tool-interface'
import {
  appendBooleanFlag,
  asRecordArray,
  isRecord,
  readBoolean,
  readString,
  runLarkCli,
} from './runner'

const larkAuthStatusDefinition = {
  name: 'lark_auth_status',
  description:
    '检查当前 lark-cli 的认证、令牌和连通性状态。适合在执行飞书相关任务前确认当前身份、token 是否有效、doctor 检查是否通过。',
  parameters: {
    verify: {
      type: 'boolean' as const,
      description: '是否向飞书服务端校验当前 token，默认 true',
      default: true,
    },
    offline: {
      type: 'boolean' as const,
      description: 'doctor 是否跳过网络检查，默认 false',
      default: false,
    },
    include_scopes: {
      type: 'boolean' as const,
      description: '是否在输出中附带完整 scope 列表，默认 false',
      default: false,
    },
  } as Record<string, ToolParameterSchema>,
  readOnly: true,
} as const

export function createLarkAuthStatusTool(): Tool {
  return {
    definition: larkAuthStatusDefinition,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const verify = params.verify !== false
      const offline = params.offline === true
      const includeScopes = params.include_scopes === true

      const statusArgs = ['auth', 'status']
      appendBooleanFlag(statusArgs, '--verify', verify)

      const doctorArgs = ['doctor']
      appendBooleanFlag(doctorArgs, '--offline', offline)

      const [statusResult, doctorResult] = await Promise.all([
        runLarkCli(statusArgs, { parseMode: 'json' }),
        runLarkCli(doctorArgs, { parseMode: 'json' }),
      ])

      if (!statusResult.ok) {
        return errorResult(`lark-cli 认证状态查询失败: ${statusResult.error}`)
      }

      if (!doctorResult.ok) {
        return errorResult(`lark-cli doctor 检查失败: ${doctorResult.error}`)
      }

      if (!isRecord(statusResult.parsed) || !isRecord(doctorResult.parsed)) {
        return errorResult('lark-cli 认证状态输出格式无效')
      }

      const failedChecks = asRecordArray(doctorResult.parsed.checks).filter(
        (check) => readString(check, 'status') !== 'pass',
      )

      const scope = readString(statusResult.parsed, 'scope')
      const lines = [
        `identity: ${readString(statusResult.parsed, 'identity') || 'unknown'}`,
        `user: ${readString(statusResult.parsed, 'userName') || 'unknown'}`,
        `user_open_id: ${readString(statusResult.parsed, 'userOpenId') || 'unknown'}`,
        `token_status: ${readString(statusResult.parsed, 'tokenStatus') || 'unknown'}`,
        `verified: ${readBoolean(statusResult.parsed, 'verified') === true ? 'yes' : 'no'}`,
        `doctor_ok: ${readBoolean(doctorResult.parsed, 'ok') === true ? 'yes' : 'no'}`,
      ]

      if (failedChecks.length > 0) {
        lines.push('doctor_failures:')
        for (const check of failedChecks) {
          lines.push(
            `- ${readString(check, 'name') || 'unknown'}: ${readString(check, 'message') || 'failed'}`,
          )
        }
      }

      if (includeScopes && scope) {
        lines.push(`scopes: ${scope}`)
      }

      return successResult(lines.join('\n'), {
        status: statusResult.parsed,
        doctor: doctorResult.parsed,
      })
    },

    validateParams(params: Record<string, unknown>): { valid: boolean; errors?: string[] } {
      const errors: string[] = []

      if (params.verify !== undefined && typeof params.verify !== 'boolean') {
        errors.push('verify 参数必须是布尔值')
      }

      if (params.offline !== undefined && typeof params.offline !== 'boolean') {
        errors.push('offline 参数必须是布尔值')
      }

      if (params.include_scopes !== undefined && typeof params.include_scopes !== 'boolean') {
        errors.push('include_scopes 参数必须是布尔值')
      }

      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined }
    },
  }
}
