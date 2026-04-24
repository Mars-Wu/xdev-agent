import * as path from 'path'
import { createLogger } from '../utils/logger'
import {
  generateOrLoadCodebaseSnapshot,
  getCodebaseSnapshotArtifactPaths,
  saveCodebaseSnapshot,
} from '../context/codebase-map'
import {
  TopicGraph,
  getTopicGraphArtifactPaths,
  renderTopicGraphSnapshotMarkdown,
} from '../storage/topic-graph'
import { AnalysisCache, createAnalysisFingerprint } from '../storage/analysis-cache'
import { MemoryManager } from '../memory/memory-manager'
import type { MemoryEntry } from '../memory/types'
import {
  TaskSystem,
  getTaskGraphArtifactPaths,
  renderTaskGraphAnalysisMarkdown,
} from '../tools/task-system'
import { PATHS } from '../config'

const logger = createLogger('export-status')

export interface ArtifactExportStatus {
  jsonPath: string
  markdownPath: string
  cacheHit: boolean
  fingerprint: string
}

export interface MemoryOverviewSnapshot {
  version: 1
  generatedAt: string
  summary: {
    total: number
    byType: Record<string, number>
    byCategory: Record<string, number>
    withMetadata: number
    withConfidence: number
    highImportance: number
  }
  memories: Array<{
    id: string
    type: string
    category: string
    importance: number
    tags: string[]
    preview: string
    metadata?: Record<string, unknown>
  }>
}

export interface ExportStatusSummary {
  generatedAt: string
  projectPath: string
  codebase: ArtifactExportStatus & { rootPath: string }
  topicGraph: ArtifactExportStatus
  taskGraph: ArtifactExportStatus
  memory: ArtifactExportStatus
}

export async function exportStatus(options: { projectPath?: string } = {}): Promise<ExportStatusSummary> {
  const cache = new AnalysisCache()
  const projectPath = path.resolve(options.projectPath || getDefaultProjectPath())

  const codebaseResult = await generateOrLoadCodebaseSnapshot(projectPath)
  if (!codebaseResult.cacheHit) {
    await saveCodebaseSnapshot(codebaseResult.snapshot)
  }
  const codebasePaths = getCodebaseSnapshotArtifactPaths(projectPath)

  const topicGraph = new TopicGraph()
  topicGraph.init()
  const topicSnapshot = topicGraph.buildSnapshot()
  const topicFingerprint = createAnalysisFingerprint(stableFingerprintValue(topicSnapshot))
  const topicPaths = getTopicGraphArtifactPaths()
  const topicCache = await cache.writeArtifacts(
    'observability',
    'topic-graph',
    topicFingerprint,
    [
      { path: topicPaths.jsonPath, content: JSON.stringify(topicSnapshot, null, 2) },
      { path: topicPaths.markdownPath, content: renderTopicGraphSnapshotMarkdown(topicSnapshot) },
    ],
    { topicCount: topicSnapshot.summary.topicCount },
  )
  topicGraph.close()

  const taskSystem = new TaskSystem()
  await taskSystem.initialize()
  const taskAnalysis = taskSystem.buildGraphAnalysis()
  const taskFingerprint = createAnalysisFingerprint(stableFingerprintValue(taskAnalysis))
  const taskPaths = getTaskGraphArtifactPaths()
  const taskCache = await cache.writeArtifacts(
    'observability',
    'task-graph',
    taskFingerprint,
    [
      { path: taskPaths.jsonPath, content: JSON.stringify(taskAnalysis, null, 2) },
      { path: taskPaths.markdownPath, content: renderTaskGraphAnalysisMarkdown(taskAnalysis) },
    ],
    { taskCount: taskAnalysis.summary.total },
  )
  await taskSystem.shutdown()

  const memoryManager = new MemoryManager()
  await memoryManager.initialize()
  const memorySnapshot = buildMemoryOverviewSnapshot(await memoryManager.loadMemories())
  const memoryFingerprint = createAnalysisFingerprint(stableFingerprintValue(memorySnapshot))
  const memoryPaths = getMemoryArtifactPaths()
  const memoryCache = await cache.writeArtifacts(
    'observability',
    'memory-report',
    memoryFingerprint,
    [
      { path: memoryPaths.jsonPath, content: JSON.stringify(memorySnapshot, null, 2) },
      { path: memoryPaths.markdownPath, content: renderMemoryOverviewMarkdown(memorySnapshot) },
    ],
    { memoryCount: memorySnapshot.summary.total },
  )

  const summary: ExportStatusSummary = {
    generatedAt: new Date().toISOString(),
    projectPath,
    codebase: {
      rootPath: codebaseResult.snapshot.rootPath,
      jsonPath: codebasePaths.jsonPath,
      markdownPath: codebasePaths.markdownPath,
      cacheHit: codebaseResult.cacheHit,
      fingerprint: codebaseResult.snapshot.sourceFingerprint || 'n/a',
    },
    topicGraph: {
      jsonPath: topicPaths.jsonPath,
      markdownPath: topicPaths.markdownPath,
      cacheHit: topicCache.cacheHit,
      fingerprint: topicFingerprint,
    },
    taskGraph: {
      jsonPath: taskPaths.jsonPath,
      markdownPath: taskPaths.markdownPath,
      cacheHit: taskCache.cacheHit,
      fingerprint: taskFingerprint,
    },
    memory: {
      jsonPath: memoryPaths.jsonPath,
      markdownPath: memoryPaths.markdownPath,
      cacheHit: memoryCache.cacheHit,
      fingerprint: memoryFingerprint,
    },
  }

  logger.info(`状态导出完成: ${summary.projectPath}`)
  return summary
}

export function renderExportStatus(summary: ExportStatusSummary): string {
  return [
    '# Export Status',
    '',
    `- generated_at: ${summary.generatedAt}`,
    `- project_path: ${summary.projectPath}`,
    '',
    formatArtifactSection('codebase', summary.codebase),
    formatArtifactSection('topic_graph', summary.topicGraph),
    formatArtifactSection('task_graph', summary.taskGraph),
    formatArtifactSection('memory', summary.memory),
  ].join('\n')
}

export function buildMemoryOverviewSnapshot(memories: MemoryEntry[]): MemoryOverviewSnapshot {
  const byType: Record<string, number> = {}
  const byCategory: Record<string, number> = {}
  let withMetadata = 0
  let withConfidence = 0
  let highImportance = 0

  for (const memory of memories) {
    byType[memory.type] = (byType[memory.type] || 0) + 1
    byCategory[memory.category] = (byCategory[memory.category] || 0) + 1
    if (memory.metadata) withMetadata += 1
    if (typeof memory.metadata?.confidence === 'number') withConfidence += 1
    if (memory.importance >= 8) highImportance += 1
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      total: memories.length,
      byType,
      byCategory,
      withMetadata,
      withConfidence,
      highImportance,
    },
    memories: memories
      .slice()
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, 50)
      .map(memory => ({
        id: memory.id,
        type: memory.type,
        category: memory.category,
        importance: memory.importance,
        tags: memory.tags,
        preview: memory.content.slice(0, 160),
        metadata: memory.metadata,
      })),
  }
}

export function renderMemoryOverviewMarkdown(snapshot: MemoryOverviewSnapshot): string {
  const lines = [
    '# Memory Report',
    '',
    `- 生成时间：${snapshot.generatedAt}`,
    `- 记忆总数：${snapshot.summary.total}`,
    `- 带 metadata：${snapshot.summary.withMetadata}`,
    `- 带 confidence：${snapshot.summary.withConfidence}`,
    `- 高重要性（>=8）：${snapshot.summary.highImportance}`,
    '',
    '## By Type',
    '',
  ]

  for (const [type, count] of Object.entries(snapshot.summary.byType)) {
    lines.push(`- ${type}: ${count}`)
  }

  lines.push('', '## By Category', '')
  for (const [category, count] of Object.entries(snapshot.summary.byCategory)) {
    lines.push(`- ${category}: ${count}`)
  }

  lines.push('', '## Top Entries', '')
  if (snapshot.memories.length === 0) {
    lines.push('- （暂无）')
  } else {
    for (const memory of snapshot.memories.slice(0, 10)) {
      lines.push(
        `- **${memory.id}** [${memory.type}/${memory.category}] importance=${memory.importance} ` +
        `${memory.preview}`,
      )
    }
  }

  return lines.join('\n')
}

export function getMemoryArtifactPaths(): { jsonPath: string; markdownPath: string } {
  const baseDir = path.join(PATHS.CACHE_DIR, 'observability')
  return {
    jsonPath: path.join(baseDir, 'memory-report.json'),
    markdownPath: path.join(baseDir, 'memory-report.md'),
  }
}

export function getDefaultProjectPath(): string {
  return path.resolve(__dirname, '..', '..')
}

function formatArtifactSection(label: string, artifact: ArtifactExportStatus): string {
  return [
    `## ${label}`,
    '',
    `- cache_hit: ${artifact.cacheHit ? 'yes' : 'no'}`,
    `- fingerprint: ${artifact.fingerprint}`,
    `- json: ${artifact.jsonPath}`,
    `- markdown: ${artifact.markdownPath}`,
    '',
  ].join('\n')
}

function stableFingerprintValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => stableFingerprintValue(item)) as T
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'generatedAt')
      .map(([key, entryValue]) => [key, stableFingerprintValue(entryValue)])
    return Object.fromEntries(entries) as T
  }

  return value
}
