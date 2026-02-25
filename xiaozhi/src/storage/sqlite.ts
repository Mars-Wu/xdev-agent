// src/storage/sqlite.ts
// SQLite存储封装

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

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
    // 创建sessions表
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

    // 创建workers表
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

    // 创建索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
      CREATE INDEX IF NOT EXISTS idx_sessions_feishuChatId ON sessions(feishuChatId);
      CREATE INDEX IF NOT EXISTS idx_workers_sessionId ON workers(sessionId);
      CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
    `);
  }

  // Session操作
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

  // Worker操作
  getWorker(id: string): WorkerRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM workers WHERE id = ?');
    return stmt.get(id) as WorkerRecord | undefined;
  }

  getWorkersBySession(sessionId: string): WorkerRecord[] {
    const stmt = this.db.prepare('SELECT * FROM workers WHERE sessionId = ?');
    return stmt.all(sessionId) as WorkerRecord[];
  }

  /**
   * 获取所有指定状态的 Worker
   */
  getWorkersByStatus(status: string): WorkerRecord[] {
    const stmt = this.db.prepare('SELECT * FROM workers WHERE status = ?');
    return stmt.all(status) as WorkerRecord[];
  }

  /**
   * 获取所有运行中的 Worker
   */
  getRunningWorkers(): WorkerRecord[] {
    const stmt = this.db.prepare("SELECT * FROM workers WHERE status = 'running'");
    return stmt.all() as WorkerRecord[];
  }

  /**
   * 获取所有活跃的 Worker（运行中或暂停）
   */
  getActiveWorkers(): WorkerRecord[] {
    const stmt = this.db.prepare("SELECT * FROM workers WHERE status IN ('running', 'pending', 'paused')");
    return stmt.all() as WorkerRecord[];
  }

  /**
   * 获取所有 Worker
   */
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

  close(): void {
    this.db.close();
  }
}
