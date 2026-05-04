import * as fs from 'fs/promises'
import * as path from 'path'
import { spawnSync } from 'child_process'
import * as dotenv from 'dotenv'
import { PATHS } from '../config'
import { createDefaultToolRegistry } from '../tools'
import { exportStatus, getDefaultProjectPath, renderExportStatus } from './export-status'

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: DoctorCheckStatus
  summary: string
  detail?: string
}

export interface DoctorResult {
  ok: boolean
  generatedAt: string
  checks: DoctorCheck[]
}

export interface SmokeCheckResult {
  ok: boolean
  generatedAt: string
  checks: DoctorCheck[]
  exportStatus?: string
}

export async function runDoctor(
  options: { envFile?: string; healthUrl?: string; packageRoot?: string } = {},
): Promise<DoctorResult> {
  const packageRoot = options.packageRoot || getDefaultProjectPath()
  const env = await loadEnvironment(options.envFile)
  const checks: DoctorCheck[] = []

  checks.push(checkNodeVersion())
  checks.push(await checkBuildArtifacts(packageRoot))
  checks.push(await checkRuntimePaths(env.XDEV_HOME || PATHS.XDEV_HOME))
  checks.push(checkRequiredEnv(env, options.envFile))

  const serviceCheck = checkSystemdService()
  checks.push(serviceCheck)

  const healthUrl = options.healthUrl || buildHealthUrl(env)
  if (healthUrl) {
    checks.push(await checkHealthEndpoint(healthUrl, serviceCheck.status === 'pass'))
  }

  checks.push(checkToolRegistry())
  checks.push(checkOptionalCommand('lark-cli', 'lark-cli 已安装，可直接联调飞书链路'))

  return {
    ok: checks.every(check => check.status !== 'fail'),
    generatedAt: new Date().toISOString(),
    checks,
  }
}

export async function runSmokeCheck(
  options: { envFile?: string; healthUrl?: string; packageRoot?: string; projectPath?: string } = {},
): Promise<SmokeCheckResult> {
  const checks: DoctorCheck[] = []
  const registry = createDefaultToolRegistry()
  checks.push({
    id: 'tool-registry',
    status: registry.getDefinitions().length > 0 ? 'pass' : 'fail',
    summary: `工具注册表已加载 ${registry.getDefinitions().length} 个工具`,
  })

  try {
    const status = await exportStatus({ projectPath: options.projectPath || options.packageRoot })
    checks.push({
      id: 'export-status',
      status: 'pass',
      summary: '可观测导出已生成',
      detail: renderExportStatus(status),
    })
  } catch (error) {
    checks.push({
      id: 'export-status',
      status: 'fail',
      summary: '可观测导出失败',
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  const doctor = await runDoctor(options)
  checks.push({
    id: 'doctor-summary',
    status: doctor.ok ? 'pass' : 'warn',
    summary: `doctor 检查 ${doctor.ok ? '通过' : '存在失败项'}`,
    detail: renderDoctorResult(doctor),
  })

  return {
    ok: checks.every(check => check.status !== 'fail'),
    generatedAt: new Date().toISOString(),
    checks,
    exportStatus: checks.find(check => check.id === 'export-status')?.detail,
  }
}

export function renderDoctorResult(result: DoctorResult): string {
  const lines = ['# Doctor', '', `- ok: ${result.ok ? 'yes' : 'no'}`, `- generated_at: ${result.generatedAt}`, '']
  for (const check of result.checks) {
    lines.push(`- [${check.status}] ${check.id}: ${check.summary}`)
    if (check.detail) {
      lines.push(`  ${check.detail.replace(/\n/g, '\n  ')}`)
    }
  }
  return lines.join('\n')
}

export function renderSmokeCheckResult(result: SmokeCheckResult): string {
  const lines = ['# Smoke Check', '', `- ok: ${result.ok ? 'yes' : 'no'}`, `- generated_at: ${result.generatedAt}`, '']
  for (const check of result.checks) {
    lines.push(`- [${check.status}] ${check.id}: ${check.summary}`)
  }
  if (result.exportStatus) {
    lines.push('', result.exportStatus)
  }
  return lines.join('\n')
}

async function loadEnvironment(envFile?: string): Promise<Record<string, string>> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      merged[key] = value
    }
  }

  const candidateFiles = [envFile, '/etc/xdev/environment'].filter(Boolean) as string[]
  for (const filePath of candidateFiles) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      Object.assign(merged, dotenv.parse(raw))
      break
    } catch {
      // ignore missing env file
    }
  }

  return merged
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split('.')[0] || 0)
  return {
    id: 'node-version',
    status: major >= 18 ? 'pass' : 'fail',
    summary: `当前 Node.js ${process.versions.node}`,
  }
}

async function checkBuildArtifacts(packageRoot: string): Promise<DoctorCheck> {
  const requiredFiles = [
    path.join(packageRoot, 'dist', 'index.js'),
    path.join(packageRoot, 'dist', 'cli.js'),
  ]

  const missing: string[] = []
  for (const filePath of requiredFiles) {
    try {
      await fs.access(filePath)
    } catch {
      missing.push(filePath)
    }
  }

  return missing.length === 0
    ? {
        id: 'build-artifacts',
        status: 'pass',
        summary: 'dist 构建产物完整',
      }
    : {
        id: 'build-artifacts',
        status: 'fail',
        summary: 'dist 构建产物缺失',
        detail: missing.join('\n'),
      }
}

async function checkRuntimePaths(xdevHome: string): Promise<DoctorCheck> {
  const pathsToCheck = [
    xdevHome,
    path.join(xdevHome, 'cache'),
    path.join(xdevHome, 'memory'),
  ]
  const missing: string[] = []

  for (const filePath of pathsToCheck) {
    try {
      await fs.access(filePath)
    } catch {
      missing.push(filePath)
    }
  }

  return missing.length === 0
    ? {
        id: 'runtime-paths',
        status: 'pass',
        summary: `运行时目录可用: ${xdevHome}`,
      }
    : {
        id: 'runtime-paths',
        status: 'warn',
        summary: '部分运行时目录尚未生成',
        detail: missing.join('\n'),
      }
}

function checkRequiredEnv(env: Record<string, string>, envFile?: string): DoctorCheck {
  const missing: string[] = []

  const llmApiKey = env.XDEV_LLM_API_KEY || env.DEEPSEEK_API_KEY || env.ZHIPU_API_KEY || env.ANTHROPIC_AUTH_TOKEN
  if (!llmApiKey || looksLikePlaceholder(llmApiKey)) {
    missing.push('text-llm-api-key')
  }
  if (!env.FEISHU_APP_ID || looksLikePlaceholder(env.FEISHU_APP_ID)) {
    missing.push('FEISHU_APP_ID')
  }
  if (!env.FEISHU_APP_SECRET || looksLikePlaceholder(env.FEISHU_APP_SECRET)) {
    missing.push('FEISHU_APP_SECRET')
  }
  return missing.length === 0
    ? {
        id: 'required-env',
        status: 'pass',
        summary: envFile ? `环境变量文件可用: ${envFile}` : '关键环境变量已配置',
      }
    : {
        id: 'required-env',
        status: 'fail',
        summary: '关键环境变量缺失或仍为占位值',
        detail: missing.join(', '),
      }
}

function checkSystemdService(): DoctorCheck {
  if (!commandExists('systemctl')) {
    return {
      id: 'systemd-service',
      status: 'warn',
      summary: 'systemctl 不可用，跳过 systemd 检查',
    }
  }

  const systemActive = spawnSync('systemctl', ['is-active', 'xdev'], { encoding: 'utf-8' })
  if (systemActive.status === 0) {
    return {
      id: 'systemd-service',
      status: 'pass',
      summary: 'xdev systemd 系统服务处于 active',
    }
  }

  const userActive = spawnSync('systemctl', ['--user', 'is-active', 'xdev'], { encoding: 'utf-8' })
  if (userActive.status === 0) {
    return {
      id: 'systemd-service',
      status: 'pass',
      summary: 'xdev systemd 用户服务处于 active',
    }
  }

  return {
    id: 'systemd-service',
    status: 'warn',
    summary: '未检测到 active 的 xdev 服务',
  }
}

async function checkHealthEndpoint(url: string, requireHealthy: boolean): Promise<DoctorCheck> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    return {
      id: 'health-endpoint',
      status: response.ok ? 'pass' : requireHealthy ? 'fail' : 'warn',
      summary: `健康检查 ${response.ok ? '通过' : '返回异常'}: ${url}`,
      detail: `status=${response.status}`,
    }
  } catch (error) {
    return {
      id: 'health-endpoint',
      status: requireHealthy ? 'fail' : 'warn',
      summary: `健康检查不可达: ${url}`,
      detail: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function checkToolRegistry(): DoctorCheck {
  const registry = createDefaultToolRegistry()
  const count = registry.getDefinitions().length
  return {
    id: 'tool-registry',
    status: count > 0 ? 'pass' : 'fail',
    summary: `默认工具注册表包含 ${count} 个工具`,
  }
}

function checkOptionalCommand(command: string, summary: string): DoctorCheck {
  return {
    id: `${command}-availability`,
    status: commandExists(command) ? 'pass' : 'warn',
    summary: commandExists(command) ? summary : `${command} 未安装（可选）`,
  }
}

function buildHealthUrl(env: Record<string, string>): string | undefined {
  const port = env.XDEV_HOOKS_PORT || process.env.XDEV_HOOKS_PORT
  return port ? `http://127.0.0.1:${port}/health` : undefined
}

function looksLikePlaceholder(value: string): boolean {
  return /your-|change-me|placeholder|example/i.test(value)
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf-8' })
  return result.status === 0
}
