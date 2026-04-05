// src/storage/topic-graph.ts
// 话题图存储层：话题元数据、话题间关系、pipeline 日志
// 负责话题 history 分桶的磁盘读写

import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { createLogger } from '../utils/logger'
import { MessageHistoryManager } from '../core/message-history'
import { getXiaozhiHome } from '../config'

const logger = createLogger('topic-graph')

// 话题 history bucket 的配置（远小于全局 1000/18万）
const TOPIC_HISTORY_CONFIG = {
  maxMessages: 200,
  maxTokens: 60_000,
  preserveRecent: 5,
  enableCompression: true,
  compressionThreshold: 0.9,
}

// ── 类型定义 ────────────────────────────────────────────────────────────────

export interface Topic {
  id: string
  type: string
  title?: string
  summary?: string
  entityTags: string[]
  turnCount: number
  summaryUpdatedAt?: number
  createdAt: number
  updatedAt: number
  status: 'active' | 'archived'
}

export interface TopicSummary {
  id: string
  type: string
  summary?: string
  entityTags: string[]
  updatedAt: number
  turnCount: number
}

export interface TopicRelation {
  fromTopic: string
  toTopic: string
  relation: string
  weight: number
  updatedAt: number
}

export interface PipelineLogEntry {
  ts: number
  msgPreview?: string
  topicId?: string
  isNewTopic?: boolean
  confidence?: number
  historyStrategy?: string
  contextTokens?: number
  turnCount?: number
}

// ── TopicGraph ───────────────────────────────────────────────────────────────

export class TopicGraph {
  private db: Database.Database
  private topicsDir: string

  constructor(dbPath?: string) {
    const home = getXiaozhiHome()
    const resolvedDbPath = dbPath || process.env.XIAOZHI_TOPICS_DB || path.join(home, 'topics', 'index.db')
    this.topicsDir = path.dirname(resolvedDbPath)

    fs.mkdirSync(this.topicsDir, { recursive: true })

    this.db = new Database(resolvedDbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  /**
   * 初始化数据库 schema（幂等）
   */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id                TEXT PRIMARY KEY,
        type              TEXT NOT NULL,
        title             TEXT,
        summary           TEXT,
        entity_tags       TEXT DEFAULT '[]',
        turn_count        INTEGER DEFAULT 0,
        summary_updated_at INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        status            TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS topic_relations (
        from_topic  TEXT NOT NULL,
        to_topic    TEXT NOT NULL,
        relation    TEXT NOT NULL,
        weight      REAL DEFAULT 1.0,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (from_topic, to_topic)
      );

      CREATE TABLE IF NOT EXISTS pipeline_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               INTEGER NOT NULL,
        msg_preview      TEXT,
        topic_id         TEXT,
        is_new_topic     INTEGER DEFAULT 0,
        confidence       REAL,
        history_strategy TEXT,
        context_tokens   INTEGER,
        turn_count       INTEGER,
        bg_pass_done     INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_topics_updated ON topics(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
    `)
    logger.info('话题图 schema 初始化完成')
  }

  /**
   * 获取活跃话题摘要列表（供 Stage 1 路由器使用）
   * 按 updated_at 降序，只返回 active 状态
   */
  getActiveSummaries(limit: number = 20): TopicSummary[] {
    const rows = this.db.prepare(`
      SELECT id, type, summary, entity_tags, updated_at, turn_count
      FROM topics
      WHERE status = 'active'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as any[]

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      summary: row.summary || '',
      entityTags: this.parseJson(row.entity_tags, []),
      updatedAt: row.updated_at,
      turnCount: row.turn_count,
    }))
  }

  /**
   * 获取或创建话题（幂等）
   */
  getOrCreate(topicId: string, type: string): Topic {
    const now = Date.now()
    const existing = this.db.prepare(
      'SELECT * FROM topics WHERE id = ?'
    ).get(topicId) as any

    if (existing) {
      return this.rowToTopic(existing)
    }

    this.db.prepare(`
      INSERT INTO topics (id, type, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(topicId, type, now, now)

    logger.info(`创建新话题: ${topicId} (${type})`)
    return {
      id: topicId, type, entityTags: [], turnCount: 0,
      createdAt: now, updatedAt: now, status: 'active',
    }
  }

  /**
   * 更新话题摘要和实体标签（热路径工具调用）
   */
  updateSummary(topicId: string, summary: string, entityTags?: string[]): void {
    const now = Date.now()
    const trimmedSummary = summary.slice(0, 200) // 防止摘要过长

    if (entityTags !== undefined) {
      this.db.prepare(`
        UPDATE topics SET summary = ?, entity_tags = ?, summary_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(trimmedSummary, JSON.stringify(entityTags), now, now, topicId)
    } else {
      this.db.prepare(`
        UPDATE topics SET summary = ?, summary_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(trimmedSummary, now, now, topicId)
    }
  }

  /**
   * 更新话题实体标签（Background Pass 写入）
   */
  updateEntityTags(topicId: string, tags: string[]): void {
    const now = Date.now()
    // 合并已有标签，不覆盖
    const existing = this.db.prepare('SELECT entity_tags FROM topics WHERE id = ?').get(topicId) as any
    if (!existing) return

    const existingTags: string[] = this.parseJson(existing.entity_tags, [])
    const merged = Array.from(new Set([...existingTags, ...tags]))

    this.db.prepare(
      'UPDATE topics SET entity_tags = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(merged), now, topicId)
  }

  /**
   * 自增话题轮次计数
   */
  incrementTurnCount(topicId: string): void {
    this.db.prepare(
      'UPDATE topics SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?'
    ).run(Date.now(), topicId)
  }

  /**
   * 获取话题指定邻居关系
   */
  getRelations(topicId: string): TopicRelation[] {
    const rows = this.db.prepare(`
      SELECT * FROM topic_relations WHERE from_topic = ? OR to_topic = ?
    `).all(topicId, topicId) as any[]

    return rows.map(row => ({
      fromTopic: row.from_topic,
      toTopic: row.to_topic,
      relation: row.relation,
      weight: row.weight,
      updatedAt: row.updated_at,
    }))
  }

  /**
   * 写入/更新话题关系（Background LLM 调用）
   */
  upsertRelation(fromTopic: string, toTopic: string, relation: string, weight: number): void {
    const now = Date.now()
    const clampedWeight = Math.min(1, Math.max(0, weight))
    this.db.prepare(`
      INSERT INTO topic_relations (from_topic, to_topic, relation, weight, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(from_topic, to_topic) DO UPDATE SET
        relation = excluded.relation,
        weight = excluded.weight,
        updated_at = excluded.updated_at
    `).run(fromTopic, toTopic, relation, clampedWeight, now)
  }

  /**
   * 加载话题 history（从磁盘，不存在则返回空 history）
   */
  loadHistory(topicId: string): MessageHistoryManager {
    const historyPath = this.getHistoryPath(topicId)
    const manager = new MessageHistoryManager(TOPIC_HISTORY_CONFIG)

    if (fs.existsSync(historyPath)) {
      try {
        const json = fs.readFileSync(historyPath, 'utf-8')
        manager.deserialize(json)
        logger.debug(`加载话题 ${topicId} history: ${manager.stats().messageCount} 条消息`)
      } catch (err) {
        logger.warn(`加载话题 ${topicId} history 失败，使用空 history:`, err)
      }
    }

    return manager
  }

  /**
   * 保存话题 history（到磁盘）
   */
  saveHistory(topicId: string, history: MessageHistoryManager): void {
    const historyDir = path.join(this.topicsDir, topicId)
    fs.mkdirSync(historyDir, { recursive: true })

    const historyPath = this.getHistoryPath(topicId)
    try {
      fs.writeFileSync(historyPath, history.serialize(), 'utf-8')
      logger.debug(`保存话题 ${topicId} history: ${history.stats().messageCount} 条消息`)
    } catch (err) {
      logger.error(`保存话题 ${topicId} history 失败:`, err)
    }
  }

  /**
   * 写入流水线日志
   */
  logPipeline(entry: PipelineLogEntry): void {
    this.db.prepare(`
      INSERT INTO pipeline_log
        (ts, msg_preview, topic_id, is_new_topic, confidence, history_strategy, context_tokens, turn_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.ts,
      entry.msgPreview?.slice(0, 50) ?? null,
      entry.topicId ?? null,
      entry.isNewTopic ? 1 : 0,
      entry.confidence ?? null,
      entry.historyStrategy ?? null,
      entry.contextTokens ?? null,
      entry.turnCount ?? null,
    )
  }

  /**
   * 标记 Background Pass 完成
   */
  markBgPassDone(logId: number): void {
    this.db.prepare('UPDATE pipeline_log SET bg_pass_done = 1 WHERE id = ?').run(logId)
  }

  /**
   * 获取最近 N 条 pipeline 日志
   */
  getRecentLogs(limit: number = 20): any[] {
    return this.db.prepare(
      'SELECT * FROM pipeline_log ORDER BY ts DESC LIMIT ?'
    ).all(limit)
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close()
  }

  // ── 私有方法 ──────────────────────────────────────────────────────────────

  private getHistoryPath(topicId: string): string {
    return path.join(this.topicsDir, topicId, 'history.json')
  }

  private parseJson<T>(str: string | null | undefined, fallback: T): T {
    if (!str) return fallback
    try {
      return JSON.parse(str) as T
    } catch {
      return fallback
    }
  }

  private rowToTopic(row: any): Topic {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      summary: row.summary,
      entityTags: this.parseJson(row.entity_tags, []),
      turnCount: row.turn_count,
      summaryUpdatedAt: row.summary_updated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
    }
  }
}

/**
 * 全局单例（懒加载）
 */
let _instance: TopicGraph | null = null

export function getTopicGraph(): TopicGraph {
  if (!_instance) {
    _instance = new TopicGraph()
    _instance.init()
  }
  return _instance
}
