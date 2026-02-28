// src/storage/sqlite.ts
// SQLite存储封装 - 支持会话、Worker（兼容）、专家和专家会话

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import {
  ExpertConfig,
  ExpertSession,
  ExpertStats,
  SessionTask,
  SessionExecution,
  SessionResult,
  SessionStatus,
  ExpertRecord,
  SessionRecord as ExpertSessionRecord,
} from '../expert/types';

// ==================== 飞书会话记录（兼容旧版）====================

export interface SessionRecord {
  id: string;
  name: string;
  userId: string;
  feishuChatId: string;
  status: string;
  context: string; // JSON
  settings: string; // JSON
  createdAt: string;
  updatedAt: string;
}

// ==================== Worker 记录（兼容旧版）====================

export interface WorkerRecord {
  id: string;
  name: string;
  sessionId: string;
  status: string;
  tmuxSession: string;
  claudeSessionId: string;
  task: string; // JSON
  progress: string; // JSON
  result: string; // JSON
  hooks: string; // JSON
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export class SQLiteStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    // 确保目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // P1 性能优化：启用 WAL 模式提高并发性能
    this.db.pragma('journal_mode = WAL');
    // 设置繁忙超时，避免并发锁等待
    this.db.pragma('busy_timeout = 5000');

    this.initTables();
  }

  private initTables(): void {
    // ==================== 飞书会话表（兼容旧版）====================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        userId TEXT NOT NULL,
        feishuChatId TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        context TEXT DEFAULT '{}',
        settings TEXT DEFAULT '{}',
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      )
    `);

    // ==================== Worker 表（兼容旧版）====================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        tmuxSession TEXT,
        claudeSessionId TEXT,
        task TEXT DEFAULT '{}',
        progress TEXT DEFAULT '{}',
        result TEXT,
        hooks TEXT DEFAULT '{}',
        createdAt TEXT DEFAULT (datetime('now')),
        startedAt TEXT,
        completedAt TEXT,
        FOREIGN KEY (sessionId) REFERENCES sessions(id)
      )
    `);

    // ==================== 专家表（新增）====================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        specialties TEXT,
        type TEXT DEFAULT 'predefined',
        work_dir TEXT NOT NULL,
        prompt_path TEXT,
        custom_prompt TEXT,
        stats TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // ==================== 专家会话表（新增）====================
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS expert_sessions (
        id TEXT PRIMARY KEY,
        expert_id TEXT NOT NULL,
        expert_name TEXT NOT NULL,
        task_description TEXT,
        task_category TEXT,
        task_tags TEXT,
        status TEXT DEFAULT 'running',
        model TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        duration INTEGER,
        result_success INTEGER,
        result_summary TEXT,
        result_details TEXT,
        result_artifacts TEXT,
        work_dir TEXT,
        claude_session_id TEXT,
        FOREIGN KEY (expert_id) REFERENCES experts(id)
      )
    `);

    // ==================== 索引 ====================
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
      CREATE INDEX IF NOT EXISTS idx_sessions_feishuChatId ON sessions(feishuChatId);
      CREATE INDEX IF NOT EXISTS idx_workers_sessionId ON workers(sessionId);
      CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
      CREATE INDEX IF NOT EXISTS idx_expert_sessions_expert_id ON expert_sessions(expert_id);
      CREATE INDEX IF NOT EXISTS idx_expert_sessions_status ON expert_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_expert_sessions_started_at ON expert_sessions(started_at);
    `);
  }

  // ==================== 飞书会话操作（兼容旧版）====================

  getSession(id: string): SessionRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id) as SessionRecord | undefined;
  }

  getSessionByChatId(chatId: string): SessionRecord | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE feishuChatId = ? AND status = 'active'"
    );
    return stmt.get(chatId) as SessionRecord | undefined;
  }

  saveSession(session: Partial<SessionRecord> & { id: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, name, userId, feishuChatId, status, context, settings)
      VALUES (@id, @name, @userId, @feishuChatId, @status, @context, @settings)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        status = @status,
        context = @context,
        settings = @settings,
        updatedAt = datetime('now')
    `);

    stmt.run({
      id: session.id,
      name: session.name || '',
      userId: session.userId || '',
      feishuChatId: session.feishuChatId || '',
      status: session.status || 'active',
      context: session.context || '{}',
      settings: session.settings || '{}',
    });
  }

  updateSessionContext(id: string, context: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions SET context = ?, updatedAt = datetime('now') WHERE id = ?
    `);
    stmt.run(context, id);
  }

  // ==================== Worker 操作（兼容旧版）====================

  getWorker(id: string): WorkerRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM workers WHERE id = ?');
    return stmt.get(id) as WorkerRecord | undefined;
  }

  getWorkersBySession(sessionId: string): WorkerRecord[] {
    const stmt = this.db.prepare('SELECT * FROM workers WHERE sessionId = ?');
    return stmt.all(sessionId) as WorkerRecord[];
  }

  getWorkersByStatus(status: string): WorkerRecord[] {
    const stmt = this.db.prepare('SELECT * FROM workers WHERE status = ?');
    return stmt.all(status) as WorkerRecord[];
  }

  getRunningWorkers(): WorkerRecord[] {
    const stmt = this.db.prepare("SELECT * FROM workers WHERE status = 'running'");
    return stmt.all() as WorkerRecord[];
  }

  getActiveWorkers(): WorkerRecord[] {
    const stmt = this.db.prepare("SELECT * FROM workers WHERE status IN ('running', 'pending', 'paused')");
    return stmt.all() as WorkerRecord[];
  }

  getAllWorkers(): WorkerRecord[] {
    const stmt = this.db.prepare('SELECT * FROM workers ORDER BY createdAt DESC');
    return stmt.all() as WorkerRecord[];
  }

  saveWorker(worker: Partial<WorkerRecord> & { id: string }): void {
    const stmt = this.db.prepare(`
      INSERT INTO workers (id, name, sessionId, status, tmuxSession, claudeSessionId, task, progress, result, hooks, startedAt)
      VALUES (@id, @name, @sessionId, @status, @tmuxSession, @claudeSessionId, @task, @progress, @result, @hooks, @startedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        status = @status,
        progress = @progress,
        result = @result,
        completedAt = @completedAt
    `);

    stmt.run({
      id: worker.id,
      name: worker.name || '',
      sessionId: worker.sessionId || '',
      status: worker.status || 'pending',
      tmuxSession: worker.tmuxSession || '',
      claudeSessionId: worker.claudeSessionId || '',
      task: worker.task || '{}',
      progress: worker.progress || '{}',
      result: worker.result || null,
      hooks: worker.hooks || '{}',
      startedAt: worker.startedAt || null,
      completedAt: worker.completedAt || null,
    });
  }

  updateWorkerStatus(
    id: string,
    status: string,
    result?: string,
    completedAt?: string
  ): void {
    const stmt = this.db.prepare(`
      UPDATE workers SET
        status = ?,
        result = COALESCE(?, result),
        completedAt = COALESCE(?, completedAt)
      WHERE id = ?
    `);
    stmt.run(status, result || null, completedAt || null, id);
  }

  // ==================== 专家操作（新增）====================

  /**
   * 获取专家
   */
  getExpert(id: string): ExpertRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM experts WHERE id = ?');
    return stmt.get(id) as ExpertRecord | undefined;
  }

  /**
   * 通过名称获取专家
   */
  getExpertByName(name: string): ExpertRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM experts WHERE name = ?');
    return stmt.get(name) as ExpertRecord | undefined;
  }

  /**
   * 获取所有专家
   */
  getAllExperts(): ExpertRecord[] {
    const stmt = this.db.prepare('SELECT * FROM experts ORDER BY created_at DESC');
    return stmt.all() as ExpertRecord[];
  }

  /**
   * 保存专家
   */
  saveExpert(expert: ExpertConfig): void {
    const stmt = this.db.prepare(`
      INSERT INTO experts (id, name, description, specialties, type, work_dir, prompt_path, custom_prompt, stats)
      VALUES (@id, @name, @description, @specialties, @type, @work_dir, @prompt_path, @custom_prompt, @stats)
      ON CONFLICT(id) DO UPDATE SET
        description = @description,
        specialties = @specialties,
        type = @type,
        work_dir = @work_dir,
        prompt_path = @prompt_path,
        custom_prompt = @custom_prompt,
        stats = @stats
    `);

    stmt.run({
      id: expert.id,
      name: expert.name,
      description: expert.description,
      specialties: JSON.stringify(expert.specialties),
      type: expert.type,
      work_dir: expert.workDir,
      prompt_path: expert.promptPath,
      custom_prompt: expert.customPrompt || null,
      stats: JSON.stringify(expert.stats),
    });
  }

  /**
   * 更新专家统计
   */
  updateExpertStats(id: string, stats: ExpertStats): void {
    const stmt = this.db.prepare(`
      UPDATE experts SET stats = ? WHERE id = ?
    `);
    stmt.run(JSON.stringify(stats), id);
  }

  /**
   * 删除专家
   */
  deleteExpert(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM experts WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ==================== 专家会话操作（新增）====================

  /**
   * 获取专家会话
   */
  getExpertSession(id: string): ExpertSession | undefined {
    const stmt = this.db.prepare('SELECT * FROM expert_sessions WHERE id = ?');
    const record = stmt.get(id) as ExpertSessionRecord | undefined;
    return record ? this.recordToSession(record) : undefined;
  }

  /**
   * 获取专家的所有会话
   */
  getExpertSessions(expertId: string, limit: number = 50): ExpertSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM expert_sessions
      WHERE expert_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    const records = stmt.all(expertId, limit) as ExpertSessionRecord[];
    return records.map(r => this.recordToSession(r));
  }

  /**
   * 获取专家最近的会话
   */
  getLatestExpertSession(expertId: string): ExpertSession | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM expert_sessions
      WHERE expert_id = ?
      ORDER BY started_at DESC
      LIMIT 1
    `);
    const record = stmt.get(expertId) as ExpertSessionRecord | undefined;
    return record ? this.recordToSession(record) : undefined;
  }

  /**
   * 获取运行中的会话
   */
  getRunningSessions(): ExpertSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM expert_sessions
      WHERE status = 'running'
      ORDER BY started_at DESC
    `);
    const records = stmt.all() as ExpertSessionRecord[];
    return records.map(r => this.recordToSession(r));
  }

  /**
   * 获取所有会话
   */
  getAllExpertSessions(limit: number = 100): ExpertSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM expert_sessions
      ORDER BY started_at DESC
      LIMIT ?
    `);
    const records = stmt.all(limit) as ExpertSessionRecord[];
    return records.map(r => this.recordToSession(r));
  }

  /**
   * 保存专家会话
   */
  saveExpertSession(session: ExpertSession): void {
    const stmt = this.db.prepare(`
      INSERT INTO expert_sessions (
        id, expert_id, expert_name, task_description, task_category, task_tags,
        status, model, started_at, completed_at, duration,
        result_success, result_summary, result_details, result_artifacts,
        work_dir, claude_session_id
      )
      VALUES (
        @id, @expert_id, @expert_name, @task_description, @task_category, @task_tags,
        @status, @model, @started_at, @completed_at, @duration,
        @result_success, @result_summary, @result_details, @result_artifacts,
        @work_dir, @claude_session_id
      )
      ON CONFLICT(id) DO UPDATE SET
        status = @status,
        completed_at = @completed_at,
        duration = @duration,
        result_success = @result_success,
        result_summary = @result_summary,
        result_details = @result_details,
        result_artifacts = @result_artifacts,
        claude_session_id = @claude_session_id
    `);

    stmt.run({
      id: session.id,
      expert_id: session.expertId,
      expert_name: session.expertName,
      task_description: session.task.description,
      task_category: session.task.category || null,
      task_tags: JSON.stringify(session.task.tags),
      status: session.status,
      model: session.execution.model,
      started_at: session.execution.startedAt.toISOString(),
      completed_at: session.execution.completedAt?.toISOString() || null,
      duration: session.execution.duration || null,
      result_success: session.result?.success ? 1 : 0,
      result_summary: session.result?.summary || null,
      result_details: session.result?.details || null,
      result_artifacts: session.result?.artifacts ? JSON.stringify(session.result.artifacts) : null,
      work_dir: session.workDir || null,
      claude_session_id: session.claudeSessionId || null,
    });
  }

  /**
   * 更新会话状态
   */
  updateExpertSessionStatus(
    id: string,
    status: string,
    result?: SessionResult
  ): void {
    const stmt = this.db.prepare(`
      UPDATE expert_sessions SET
        status = ?,
        completed_at = COALESCE(?, completed_at),
        duration = COALESCE(?, duration),
        result_success = COALESCE(?, result_success),
        result_summary = COALESCE(?, result_summary),
        result_details = COALESCE(?, result_details),
        result_artifacts = COALESCE(?, result_artifacts)
      WHERE id = ?
    `);

    const now = new Date();
    stmt.run(
      status,
      status !== 'running' ? now.toISOString() : null,
      null, // duration 需要单独计算
      result?.success !== undefined ? (result.success ? 1 : 0) : null,
      result?.summary || null,
      result?.details || null,
      result?.artifacts ? JSON.stringify(result.artifacts) : null,
      id
    );
  }

  /**
   * 清理旧会话
   */
  cleanupOldSessions(retentionDays: number = 30): number {
    const stmt = this.db.prepare(`
      DELETE FROM expert_sessions
      WHERE status IN ('completed', 'failed', 'terminated')
        AND datetime(completed_at) < datetime('now', '-' || ? || ' days')
    `);
    const result = stmt.run(retentionDays);
    return result.changes;
  }

  /**
   * 数据库记录转会话对象
   */
  private recordToSession(record: ExpertSessionRecord): ExpertSession {
    const task: SessionTask = {
      description: record.task_description || '',
      category: record.task_category || undefined,
      tags: record.task_tags ? JSON.parse(record.task_tags) : [],
    };

    const execution: SessionExecution = {
      model: record.model || '',
      startedAt: new Date(record.started_at),
      completedAt: record.completed_at ? new Date(record.completed_at) : undefined,
      duration: record.duration || undefined,
    };

    let result: SessionResult | undefined;
    if (record.result_summary) {
      result = {
        success: record.result_success === 1,
        summary: record.result_summary,
        details: record.result_details || undefined,
        artifacts: record.result_artifacts ? JSON.parse(record.result_artifacts) : undefined,
      };
    }

    return {
      id: record.id,
      expertId: record.expert_id,
      expertName: record.expert_name,
      task,
      status: record.status as SessionStatus,
      execution,
      result,
      workDir: record.work_dir || undefined,
      claudeSessionId: record.claude_session_id || undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
