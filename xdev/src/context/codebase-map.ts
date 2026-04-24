import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { execFile as execFileCallback } from 'child_process'
import { PATHS } from '../config'
import { createLogger } from '../utils/logger'

const logger = createLogger('codebase-map')
const execFile = promisify(execFileCallback)

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  '.cache',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'out',
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.h': 'C/C++ Header',
  '.hpp': 'C/C++ Header',
  '.cs': 'C#',
  '.scala': 'Scala',
  '.lua': 'Lua',
  '.sh': 'Shell',
}

const MAX_TREE_LINES = 120
const MAX_CORE_MODULES = 12
const MAX_TEST_SAMPLES = 8

const MODULE_DESCRIPTIONS: Record<string, string> = {
  agent: 'Agent 执行与调度逻辑',
  api: 'HTTP API 与 Webhook 接入层',
  attachments: '附件处理相关逻辑',
  browser: '浏览器自动化与页面交互能力',
  config: '配置加载、校验与热更新',
  context: '上下文构建与压缩逻辑',
  core: '核心运行时、模型调用与主流程编排',
  feishu: '飞书集成与消息通道逻辑',
  file: '文件处理与读写能力',
  gateway: 'Gateway 服务与实时 RPC 通信',
  mcp: 'MCP 适配与对外工具协议',
  memory: '记忆提取、存储与检索',
  monitor: '监控、巡检与诊断相关逻辑',
  permissions: '权限控制与安全校验',
  plugins: '插件实现集合',
  'plugin-sdk': '插件接口、事件总线与插件宿主',
  prompt: 'Prompt 构建与模板逻辑',
  session: '会话管理与上下文状态',
  skills: '技能定义、加载与注册',
  storage: '持久化存储、索引与数据库访问',
  tasks: '任务编排相关逻辑',
  telemetry: '遥测、成本统计与运行指标',
  tools: '工具实现、注册与工具系统',
  utils: '通用工具函数与基础设施',
  worker: 'Worker 与自治执行逻辑',
  workers: 'Worker 与自治执行逻辑',
  test: '测试相关目录',
  tests: '测试相关目录',
}

export interface CodebaseSnapshot {
  version: 1
  rootPath: string
  rootName: string
  generatedAt: string
  sourceFingerprint?: string
  git: {
    isRepo: boolean
    branch?: string
    commit?: string
    dirty?: boolean
  }
  techStack: {
    languages: Array<{ name: string; fileCount: number }>
    frontend: string[]
    backend: string[]
    tests: string[]
    packageManagers: string[]
  }
  commands: {
    install: string[]
    build: string[]
    test: string[]
    dev: string[]
    start: string[]
  }
  sourceRoots: string[]
  sourceFileCount: number
  testFiles: {
    count: number
    samples: string[]
  }
  directoryTree: {
    lines: string[]
    truncated: boolean
    maxLines: number
  }
  coreModules: Array<{
    name: string
    path: string
    summary: string
  }>
}

interface GenerateCodebaseSnapshotOptions {
  maxTreeLines?: number
}

interface RepositoryScanResult {
  sourceFiles: string[]
  testFiles: string[]
  directoryTree: {
    lines: string[]
    truncated: boolean
  }
}

export async function generateCodebaseSnapshot(
  rootPath: string,
  options: GenerateCodebaseSnapshotOptions = {},
): Promise<CodebaseSnapshot> {
  const resolvedRoot = path.resolve(rootPath)
  const stat = await fs.stat(resolvedRoot)
  if (!stat.isDirectory()) {
    throw new Error(`路径不是目录: ${resolvedRoot}`)
  }

  const [{ git, sourceFingerprint }, packageJson, scan] = await Promise.all([
    getGitSnapshotInfo(resolvedRoot),
    readPackageJson(resolvedRoot),
    scanRepository(resolvedRoot, options.maxTreeLines ?? MAX_TREE_LINES),
  ])

  const techStack = detectTechStack(resolvedRoot, scan.sourceFiles, packageJson)
  const commands = detectCommands(resolvedRoot, packageJson)
  const coreModules = await detectCoreModules(resolvedRoot)

  return {
    version: 1,
    rootPath: resolvedRoot,
    rootName: path.basename(resolvedRoot),
    generatedAt: new Date().toISOString(),
    sourceFingerprint,
    git,
    techStack,
    commands,
    sourceRoots: detectSourceRoots(scan.sourceFiles),
    sourceFileCount: scan.sourceFiles.length,
    testFiles: {
      count: scan.testFiles.length,
      samples: scan.testFiles.slice(0, MAX_TEST_SAMPLES),
    },
    directoryTree: {
      lines: scan.directoryTree.lines,
      truncated: scan.directoryTree.truncated,
      maxLines: options.maxTreeLines ?? MAX_TREE_LINES,
    },
    coreModules,
  }
}

export async function generateOrLoadCodebaseSnapshot(
  rootPath: string,
  options: GenerateCodebaseSnapshotOptions = {},
): Promise<{ snapshot: CodebaseSnapshot; cacheHit: boolean }> {
  const resolvedRoot = path.resolve(rootPath)
  const [{ sourceFingerprint }, existing] = await Promise.all([
    getGitSnapshotInfo(resolvedRoot),
    loadCodebaseSnapshot(resolvedRoot),
  ])

  if (
    existing &&
    sourceFingerprint &&
    existing.sourceFingerprint === sourceFingerprint
  ) {
    return { snapshot: existing, cacheHit: true }
  }

  return {
    snapshot: await generateCodebaseSnapshot(resolvedRoot, options),
    cacheHit: false,
  }
}

export function renderCodebaseSnapshotMarkdown(snapshot: CodebaseSnapshot): string {
  const lines: string[] = [
    '# 代码库快照',
    '',
    `- 根目录：\`${snapshot.rootPath}\``,
    `- 生成时间：${snapshot.generatedAt}`,
    `- Git 分支：${snapshot.git.branch || '（未检测到）'}`,
    `- Git commit：${snapshot.git.commit || '（未检测到）'}`,
    snapshot.git.isRepo ? `- 工作区状态：${snapshot.git.dirty ? 'dirty' : 'clean'}` : '- 工作区状态：（未检测到）',
    '',
    '## 技术栈',
    '',
    `- 语言：${formatNameList(snapshot.techStack.languages.map(item => `${item.name}(${item.fileCount})`))}`,
    `- 前端：${formatNameList(snapshot.techStack.frontend)}`,
    `- 后端：${formatNameList(snapshot.techStack.backend)}`,
    `- 测试：${formatNameList(snapshot.techStack.tests)}`,
    `- 包管理：${formatNameList(snapshot.techStack.packageManagers)}`,
    '',
    '## 源码概况',
    '',
    `- 源码文件数：${snapshot.sourceFileCount}`,
    `- 源码根目录：${formatNameList(snapshot.sourceRoots)}`,
    `- 测试文件数：${snapshot.testFiles.count}`,
  ]

  if (snapshot.testFiles.samples.length > 0) {
    lines.push(`- 测试样例：${snapshot.testFiles.samples.join('，')}`)
  }

  lines.push('', '## 目录结构', '')
  for (const line of snapshot.directoryTree.lines) {
    lines.push(`- ${line}`)
  }
  if (snapshot.directoryTree.truncated) {
    lines.push(`- ⚠️ 目录树已截断（仅显示前 ${snapshot.directoryTree.maxLines} 行）`)
  }

  lines.push('', '## 核心模块', '')
  lines.push('| 模块 | 路径 | 职责 |')
  lines.push('| --- | --- | --- |')
  for (const module of snapshot.coreModules) {
    lines.push(`| ${module.name} | \`${module.path}\` | ${module.summary} |`)
  }

  lines.push('', '## 常用命令', '')
  appendCommandSection(lines, '安装', snapshot.commands.install)
  appendCommandSection(lines, '构建', snapshot.commands.build)
  appendCommandSection(lines, '测试', snapshot.commands.test)
  appendCommandSection(lines, '开发', snapshot.commands.dev)
  appendCommandSection(lines, '启动', snapshot.commands.start)

  return lines.join('\n')
}

export async function saveCodebaseSnapshot(snapshot: CodebaseSnapshot): Promise<{
  jsonPath: string
  markdownPath: string
}> {
  const paths = getCodebaseSnapshotArtifactPaths(snapshot.rootPath)
  await fs.mkdir(path.dirname(paths.jsonPath), { recursive: true })
  await Promise.all([
    fs.writeFile(paths.jsonPath, JSON.stringify(snapshot, null, 2), 'utf-8'),
    fs.writeFile(paths.markdownPath, renderCodebaseSnapshotMarkdown(snapshot), 'utf-8'),
  ])
  return paths
}

export async function loadCodebaseSnapshot(rootPath: string): Promise<CodebaseSnapshot | null> {
  const paths = getCodebaseSnapshotArtifactPaths(rootPath)
  try {
    const raw = await fs.readFile(paths.jsonPath, 'utf-8')
    return JSON.parse(raw) as CodebaseSnapshot
  } catch {
    return null
  }
}

export function getCodebaseSnapshotArtifactPaths(rootPath: string): {
  jsonPath: string
  markdownPath: string
} {
  const resolvedRoot = path.resolve(rootPath)
  const rootName = sanitizeSegment(path.basename(resolvedRoot))
  const hash = createHash('sha1').update(resolvedRoot).digest('hex').slice(0, 12)
  const baseDir = path.join(PATHS.CACHE_DIR, 'codebase-maps')
  const baseName = `${rootName}-${hash}`

  return {
    jsonPath: path.join(baseDir, `${baseName}.json`),
    markdownPath: path.join(baseDir, `${baseName}.md`),
  }
}

async function readPackageJson(rootPath: string): Promise<Record<string, any> | null> {
  try {
    const raw = await fs.readFile(path.join(rootPath, 'package.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function getGitSnapshotInfo(rootPath: string): Promise<{
  git: CodebaseSnapshot['git']
  sourceFingerprint?: string
}> {
  try {
    const [branchResult, commitResult, statusResult] = await Promise.all([
      execFile('git', ['-C', rootPath, 'rev-parse', '--abbrev-ref', 'HEAD']),
      execFile('git', ['-C', rootPath, 'rev-parse', '--short', 'HEAD']),
      execFile('git', ['-C', rootPath, 'status', '--porcelain', '--untracked-files=all']),
    ])
    const branch = branchResult.stdout.trim()
    const commit = commitResult.stdout.trim()
    const status = statusResult.stdout.trim()
    return {
      git: {
        isRepo: true,
        branch,
        commit,
        dirty: status.length > 0,
      },
      sourceFingerprint: createHash('sha1')
        .update(`${branch}\n${commit}\n${status}`)
        .digest('hex'),
    }
  } catch {
    return { git: { isRepo: false } }
  }
}

async function scanRepository(rootPath: string, maxTreeLines: number): Promise<RepositoryScanResult> {
  const sourceFiles: string[] = []
  const testFiles: string[] = []
  const directoryLines: string[] = []
  let treeTruncated = false

  const walk = async (currentPath: string, depth: number): Promise<void> => {
    let entries = await fs.readdir(currentPath, { withFileTypes: true })
    entries = entries
      .filter(entry => !shouldIgnoreEntry(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)
      const relativePath = path.relative(rootPath, fullPath)

      if (entry.isDirectory()) {
        if (directoryLines.length < maxTreeLines) {
          const prefix = depth === 0 ? '' : '  '.repeat(depth)
          directoryLines.push(`${prefix}${entry.name}/`)
        } else {
          treeTruncated = true
        }
        await walk(fullPath, depth + 1)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      if (isSourceFile(relativePath)) {
        sourceFiles.push(relativePath)
      }
      if (isTestFile(relativePath)) {
        testFiles.push(relativePath)
      }
    }
  }

  await walk(rootPath, 0)

  return {
    sourceFiles,
    testFiles,
    directoryTree: {
      lines: directoryLines,
      truncated: treeTruncated,
    },
  }
}

function detectTechStack(
  rootPath: string,
  sourceFiles: string[],
  packageJson: Record<string, any> | null,
): CodebaseSnapshot['techStack'] {
  const languageCounts = new Map<string, number>()
  for (const sourceFile of sourceFiles) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(sourceFile).toLowerCase()]
    if (!language) continue
    languageCounts.set(language, (languageCounts.get(language) || 0) + 1)
  }

  const packageNames = new Set<string>([
    ...Object.keys(packageJson?.dependencies || {}),
    ...Object.keys(packageJson?.devDependencies || {}),
  ])

  const frontend = detectPackages(packageNames, {
    next: 'Next.js',
    react: 'React',
    vue: 'Vue',
    svelte: 'Svelte',
    'solid-js': 'SolidJS',
  })
  const backend = detectPackages(packageNames, {
    express: 'Express',
    fastify: 'Fastify',
    koa: 'Koa',
    '@nestjs/core': 'NestJS',
    hono: 'Hono',
  })
  const tests = detectPackages(packageNames, {
    vitest: 'Vitest',
    jest: 'Jest',
    playwright: 'Playwright',
    cypress: 'Cypress',
    mocha: 'Mocha',
  })

  const packageManagers: string[] = []
  if (hasFile(rootPath, 'package-lock.json')) packageManagers.push('npm')
  if (hasFile(rootPath, 'pnpm-lock.yaml')) packageManagers.push('pnpm')
  if (hasFile(rootPath, 'yarn.lock')) packageManagers.push('yarn')
  if (hasFile(rootPath, 'bun.lockb') || hasFile(rootPath, 'bun.lock')) packageManagers.push('bun')

  return {
    languages: Array.from(languageCounts.entries())
      .map(([name, fileCount]) => ({ name, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name)),
    frontend,
    backend,
    tests,
    packageManagers,
  }
}

function detectCommands(
  rootPath: string,
  packageJson: Record<string, any> | null,
): CodebaseSnapshot['commands'] {
  const packageManager =
    hasFile(rootPath, 'pnpm-lock.yaml') ? 'pnpm' :
      hasFile(rootPath, 'yarn.lock') ? 'yarn' :
        hasFile(rootPath, 'bun.lockb') || hasFile(rootPath, 'bun.lock') ? 'bun' :
          'npm'

  const commands: CodebaseSnapshot['commands'] = {
    install: [],
    build: [],
    test: [],
    dev: [],
    start: [],
  }

  if (packageJson) {
    commands.install.push(`${packageManager} install`)
    const scripts = packageJson.scripts || {}
    if (scripts.build) commands.build.push(`${packageManager} run build`)
    if (scripts.test) commands.test.push(`${packageManager} test`)
    if (scripts.dev) commands.dev.push(`${packageManager} run dev`)
    if (scripts.start) commands.start.push(`${packageManager} start`)
  }

  if (hasFile(rootPath, 'pyproject.toml')) {
    commands.install.push('pip install -e .')
    commands.test.push('pytest')
  }

  if (hasFile(rootPath, 'go.mod')) {
    commands.test.push('go test ./...')
    commands.build.push('go build ./...')
  }

  return commands
}

async function detectCoreModules(rootPath: string): Promise<CodebaseSnapshot['coreModules']> {
  const candidates = ['src', 'app', 'server', 'services', 'packages', 'lib']
  for (const candidate of candidates) {
    const candidatePath = path.join(rootPath, candidate)
    try {
      const stat = await fs.stat(candidatePath)
      if (!stat.isDirectory()) continue
      return summarizeModules(rootPath, candidatePath, candidate)
    } catch {
      continue
    }
  }

  return summarizeModules(rootPath, rootPath, '')
}

async function summarizeModules(
  rootPath: string,
  basePath: string,
  baseLabel: string,
): Promise<CodebaseSnapshot['coreModules']> {
  const entries = await fs.readdir(basePath, { withFileTypes: true })
  const modules: CodebaseSnapshot['coreModules'] = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldIgnoreEntry(entry.name)) continue
    if (!entry.isDirectory() && !entry.isFile()) continue
    if (entry.isFile() && !isSourceFile(entry.name)) continue

    const relPath = path.relative(rootPath, path.join(basePath, entry.name)) || entry.name
    const moduleName = baseLabel ? `${baseLabel}/${entry.name}` : entry.name
    modules.push({
      name: moduleName,
      path: relPath,
      summary: describeModule(entry.name, entry.isDirectory()),
    })

    if (modules.length >= MAX_CORE_MODULES) {
      break
    }
  }

  return modules
}

function detectSourceRoots(sourceFiles: string[]): string[] {
  const roots = new Set<string>()
  for (const file of sourceFiles) {
    const [head] = file.split(path.sep)
    roots.add(head || '.')
  }
  return Array.from(roots).sort()
}

function describeModule(entryName: string, isDirectory: boolean): string {
  const normalized = entryName.replace(/\.[^.]+$/, '').toLowerCase()
  if (MODULE_DESCRIPTIONS[normalized]) {
    return MODULE_DESCRIPTIONS[normalized]
  }
  if (normalized === 'index') {
    return '应用启动入口'
  }
  if (normalized === 'config') {
    return '配置入口与运行时参数'
  }
  return isDirectory
    ? `${normalized} 相关模块（根据目录名推断）`
    : `${normalized} 相关文件（根据文件名推断）`
}

function isSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return Boolean(LANGUAGE_BY_EXTENSION[ext])
}

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return (
    normalized.includes('/__tests__/') ||
    normalized.startsWith('tests/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx') ||
    normalized.endsWith('.test.js') ||
    normalized.endsWith('.spec.ts') ||
    normalized.endsWith('.spec.tsx') ||
    normalized.endsWith('.spec.js') ||
    /test_[^/]+\.py$/i.test(normalized)
  )
}

function shouldIgnoreEntry(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true
  return name.startsWith('.') && name !== '.github'
}

function detectPackages(packageNames: Set<string>, mapping: Record<string, string>): string[] {
  return Object.entries(mapping)
    .filter(([packageName]) => packageNames.has(packageName))
    .map(([, label]) => label)
}

function hasFile(rootPath: string, fileName: string): boolean {
  try {
    return require('fs').existsSync(path.join(rootPath, fileName))
  } catch {
    return false
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
}

function formatNameList(values: string[]): string {
  if (values.length === 0) return '（未检测到）'
  return values.join('，')
}

function appendCommandSection(lines: string[], title: string, commands: string[]): void {
  if (commands.length === 0) return
  lines.push(`### ${title}`, '')
  for (const command of commands) {
    lines.push(`- \`${command}\``)
  }
  lines.push('')
}
