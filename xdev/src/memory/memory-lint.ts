// src/memory/memory-lint.ts
// 记忆健康检查（Lint）—— 周期性扫描记忆库，发现并修复：
//   1. 重复记忆（LLM 语义判断：表达不同但含义相近的条目）
//   2. 过时记忆（LLM 判断：已不再相关或已被新信息取代的条目）
//   3. 矛盾记忆（LLM 判断：互相冲突的条目，仅报告不自动修改）
//   4. 孤立话题（算法：无关联关系 + 极少对话 + 长期未活跃）
//
// 重复/过时 → 自动删除；矛盾/孤立话题 → 仅记录报告
// LLM 使用 backgroundModel（glm-4.7-flash，免费），每批 25 条，三类同时检测

import * as fs from 'fs/promises'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import { configManager, getXdevHome } from '../config'
import type { LLMClient } from '../core/llm-client'
import type { MemoryManager } from './memory-manager'
import type { TopicGraph } from '../storage/topic-graph'
import type { MemoryEntry } from './types'

const logger = createLogger('memory-lint')

// ── 类型 ──────────────────────────────────────────────────────────────────

export type LintIssueType = 'duplicate' | 'stale' | 'orphan-topic' | 'contradiction'

export interface LintIssue {
  type: LintIssueType
  severity: 'info' | 'warn' | 'error'
  /** 涉及的记忆 ID（orphan-topic 为话题 ID）*/
  ids: string[]
  description: string
  autoFixed: boolean
}

export interface LintReport {
  runAt: string
  durationMs: number
  memoriesScanned: number
  topicsScanned: number
  issues: LintIssue[]
  fixed: number
  summary: string
}

// ── 常量 ──────────────────────────────────────────────────────────────────

const LINT_BATCH_SIZE = 25          // 每批送给 LLM 的记忆数
const ORPHAN_TOPIC_DAYS = 7         // 话题孤立判定：N 天未活跃
const ORPHAN_MIN_TURNS = 2          // 话题孤立判定：轮次 < N

// LLM 同时检测三类问题的统一 prompt
const LINT_PROMPT = `你是用户长期记忆的健康审查员。给定一批记忆条目（JSON），请同时检查三类问题：

**1. 重复（duplicate）**：两条记忆语义相近（即使措辞不同），保留重要度（importance）更高的那条。
**2. 过时（stale）**：某条记忆描述的信息极可能已经不再适用（如"用 A 框架"但明显已被后来记忆取代，或临时性内容早已过期）。
**3. 矛盾（contradiction）**：两条记忆描述同一事物却互相冲突（偏好演进、版本升级不算矛盾）。

规则：
- 只报告你有把握的问题，宁可漏报，不要误报。
- 重复：remove 填写要删除的那条 id，keep 填写保留的那条 id。
- 只输出 JSON，不要任何解释。

输出格式：
{
  "duplicates": [{"keep": "id_保留", "remove": "id_删除", "reason": "原因"}],
  "stale":      [{"id": "id_过时", "reason": "原因"}],
  "contradictions": [{"id1": "id1", "id2": "id2", "reason": "矛盾说明"}]
}

若某类无问题，对应数组为 []。`

// ── 核心类 ────────────────────────────────────────────────────────────────

export class MemoryLint {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly memoryManager: MemoryManager,
    private readonly topicGraph: TopicGraph,
  ) {}

  async run(): Promise<LintReport> {
    const startAt = Date.now()
    const runAt = new Date().toISOString()
    logger.info('[memory-lint] 开始记忆健康检查')

    const memories = await this.memoryManager.getAllMemories()
    const topics = this.topicGraph.getActiveSummaries(500)
    const issues: LintIssue[] = []

    // 1. LLM 批量分析：重复 + 过时 + 矛盾
    if (memories.length > 0) {
      issues.push(...await this.analyzeMemoriesByLLM(memories))
    }

    // 2. 算法检测：孤立话题（图结构问题，不涉及内容理解）
    issues.push(...this.findOrphanTopics(topics))

    // 3. 自动修复：重复 + 过时（矛盾/孤立话题仅记录）
    let fixed = 0
    for (const issue of issues) {
      if (issue.type === 'duplicate' || issue.type === 'stale') {
        fixed += await this.autoFix(issue)
      }
    }

    const durationMs = Date.now() - startAt
    const report: LintReport = {
      runAt,
      durationMs,
      memoriesScanned: memories.length,
      topicsScanned: topics.length,
      issues,
      fixed,
      summary: this.buildSummary(issues, fixed, memories.length, topics.length),
    }

    await this.saveReport(report)
    logger.info(`[memory-lint] 检查完成：${issues.length} 个问题，自动修复 ${fixed} 个，耗时 ${durationMs}ms`)
    return report
  }

  // ── LLM 分析 ───────────────────────────────────────────────────────────

  private async analyzeMemoriesByLLM(memories: MemoryEntry[]): Promise<LintIssue[]> {
    const issues: LintIssue[] = []
    for (let i = 0; i < memories.length; i += LINT_BATCH_SIZE) {
      const batch = memories.slice(i, i + LINT_BATCH_SIZE)
      const batchIssues = await this.analyzeBatch(batch)
      issues.push(...batchIssues)
    }
    return issues
  }

  private async analyzeBatch(batch: MemoryEntry[]): Promise<LintIssue[]> {
    try {
      const model = configManager.getConfig().model.backgroundModel
      // 只传必要字段，节省 token
      const memList = batch.map(m => ({
        id: m.id,
        type: m.type,
        category: m.category,
        importance: m.importance,
        createdAt: m.createdAt,
        content: m.content.slice(0, 200),
      }))

      const resp = await this.llmClient.chatSync({
        model,
        maxTokens: 1024,
        system: LINT_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(memList, null, 2) }],
      })

      return this.parseResponse(resp.content)
    } catch (err) {
      logger.warn('[memory-lint] LLM 分析批次失败:', err)
      return []
    }
  }

  private parseResponse(raw: string): LintIssue[] {
    const issues: LintIssue[] = []
    try {
      const jsonStart = raw.indexOf('{')
      const jsonEnd = raw.lastIndexOf('}')
      if (jsonStart < 0 || jsonEnd < 0) return []

      const result = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as {
        duplicates?: Array<{ keep: string; remove: string; reason: string }>
        stale?: Array<{ id: string; reason: string }>
        contradictions?: Array<{ id1: string; id2: string; reason: string }>
      }

      for (const d of result.duplicates ?? []) {
        issues.push({
          type: 'duplicate', severity: 'warn',
          ids: [d.remove],
          description: `与记忆 ${d.keep} 语义重复，将删除（${d.reason}）`,
          autoFixed: false,
        })
      }
      for (const s of result.stale ?? []) {
        issues.push({
          type: 'stale', severity: 'info',
          ids: [s.id],
          description: `记忆已过时，将清理（${s.reason}）`,
          autoFixed: false,
        })
      }
      for (const c of result.contradictions ?? []) {
        issues.push({
          type: 'contradiction', severity: 'warn',
          ids: [c.id1, c.id2],
          description: `矛盾（需人工审核）：${c.reason}`,
          autoFixed: false,
        })
      }
    } catch (err) {
      logger.warn('[memory-lint] 解析 LLM 响应失败:', err)
    }
    return issues
  }

  // ── 孤立话题（算法）─────────────────────────────────────────────────────

  findOrphanTopics(topics: { id: string; turnCount: number; updatedAt: number }[]): LintIssue[] {
    const now = Date.now()
    const threshold = ORPHAN_TOPIC_DAYS * 24 * 60 * 60 * 1000
    return topics
      .filter(t => {
        if (t.turnCount >= ORPHAN_MIN_TURNS) return false
        if ((now - t.updatedAt) < threshold) return false
        return this.topicGraph.getRelations(t.id).length === 0
      })
      .map(t => ({
        type: 'orphan-topic' as LintIssueType,
        severity: 'info' as const,
        ids: [t.id],
        description: `话题无关联关系，轮次仅 ${t.turnCount}，${ORPHAN_TOPIC_DAYS} 天以上未活跃`,
        autoFixed: false,
      }))
  }

  // ── 修复 ───────────────────────────────────────────────────────────────

  private async autoFix(issue: LintIssue): Promise<number> {
    let fixed = 0
    for (const id of issue.ids) {
      try {
        const ok = await this.memoryManager.removeMemory(id)
        if (ok) {
          fixed++
          issue.autoFixed = true
          logger.debug(`[memory-lint] 已删除记忆 ${id}（${issue.type}）`)
        }
      } catch (err) {
        logger.warn(`[memory-lint] 删除记忆 ${id} 失败:`, err)
      }
    }
    return fixed
  }

  // ── 工具 ───────────────────────────────────────────────────────────────

  private buildSummary(issues: LintIssue[], fixed: number, memCount: number, topicCount: number): string {
    const byType: Record<string, number> = {}
    for (const issue of issues) byType[issue.type] = (byType[issue.type] || 0) + 1
    return [
      `扫描记忆 ${memCount} 条、话题 ${topicCount} 个`,
      `发现问题 ${issues.length} 个`,
      ...(byType.duplicate    ? [`重复 ${byType.duplicate}`] : []),
      ...(byType.stale        ? [`过时 ${byType.stale}`] : []),
      ...(byType['orphan-topic'] ? [`孤立话题 ${byType['orphan-topic']}`] : []),
      ...(byType.contradiction ? [`矛盾 ${byType.contradiction}（需人工审核）`] : []),
      `自动修复 ${fixed} 个`,
    ].join('，')
  }

  private async saveReport(report: LintReport): Promise<void> {
    try {
      const stateFile = path.join(getXdevHome(), 'memory', 'lint-state.json')
      let state: { lastRun: string; lastReport: LintReport | null } = {
        lastRun: report.runAt, lastReport: report,
      }
      try {
        const existing = JSON.parse(await fs.readFile(stateFile, 'utf-8'))
        state = { ...existing, lastRun: report.runAt, lastReport: report }
      } catch { /* 首次运行 */ }
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      logger.warn('[memory-lint] 保存 lint-state.json 失败:', err)
    }
  }
}

// ── 单例 ──────────────────────────────────────────────────────────────────

let _instance: MemoryLint | null = null

export function getMemoryLint(
  llmClient: LLMClient,
  memoryManager: MemoryManager,
  topicGraph: TopicGraph,
): MemoryLint {
  if (!_instance) _instance = new MemoryLint(llmClient, memoryManager, topicGraph)
  return _instance
}

export function resetMemoryLint(): void {
  _instance = null
}
