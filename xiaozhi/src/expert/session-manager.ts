// src/expert/session-manager.ts
// 专家会话管理器 - 管理会话创建、状态更新、历史记录

import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger';
import { SQLiteStorage } from '../storage/sqlite';
import {
  ExpertSession,
  SessionStatus,
  SessionTask,
  SessionExecution,
  SessionResult,
  ExpertConfig,
  TERMINAL_STATES,
} from './types';

const logger = createLogger('session-manager');

/**
 * 会话管理器配置
 */
export interface SessionManagerConfig {
  storage: SQLiteStorage;
  expertsDir: string;
  sessionRetentionDays?: number;
}

export class SessionManager {
  private storage: SQLiteStorage;
  private expertsDir: string;
  private sessionRetentionDays: number;

  constructor(config: SessionManagerConfig) {
    this.storage = config.storage;
    this.expertsDir = config.expertsDir;
    this.sessionRetentionDays = config.sessionRetentionDays || 30;
  }

  /**
   * 生成会话 ID
   */
  generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `session-${timestamp}-${random}`;
  }

  /**
   * 创建新会话
   */
  async createSession(
    expert: ExpertConfig,
    task: string,
    options: {
      model: string;
      workDir?: string;
      category?: string;
      tags?: string[];
    }
  ): Promise<ExpertSession> {
    const sessionId = this.generateSessionId();
    const now = new Date();

    const sessionTask: SessionTask = {
      description: task,
      category: options.category,
      tags: options.tags || [],
    };

    const execution: SessionExecution = {
      model: options.model,
      startedAt: now,
    };

    const session: ExpertSession = {
      id: sessionId,
      expertId: expert.id,
      expertName: expert.name,
      task: sessionTask,
      status: 'running',
      execution,
      workDir: options.workDir || expert.workDir,
    };

    // 保存到数据库
    this.storage.saveExpertSession(session);

    // 确保专家的会话目录存在
    await this.ensureSessionDir(expert.name);

    logger.info(`创建会话: ${sessionId} (专家: ${expert.name})`);
    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): ExpertSession | undefined {
    return this.storage.getExpertSession(sessionId);
  }

  /**
   * 获取专家的会话历史
   */
  getExpertSessions(expertId: string, limit: number = 50): ExpertSession[] {
    return this.storage.getExpertSessions(expertId, limit);
  }

  /**
   * 获取专家最近的会话
   */
  getLatestSession(expertId: string): ExpertSession | undefined {
    return this.storage.getLatestExpertSession(expertId);
  }

  /**
   * 获取运行中的会话
   */
  getRunningSessions(): ExpertSession[] {
    return this.storage.getRunningSessions();
  }

  /**
   * 检查会话是否处于终态
   */
  isTerminalState(sessionId: string): boolean {
    const session = this.storage.getExpertSession(sessionId);
    if (!session) return true; // 不存在的会话视为终态
    return TERMINAL_STATES.includes(session.status);
  }

  /**
   * 获取会话当前状态
   */
  getSessionStatus(sessionId: string): SessionStatus | null {
    const session = this.storage.getExpertSession(sessionId);
    return session?.status || null;
  }

  /**
   * 更新会话状态
   *
   * 状态保护规则：
   * - 已处于终态（completed/failed/terminated）的会话不能被再次更新
   * - 返回 true 表示更新成功，false 表示被拒绝
   */
  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    result?: SessionResult
  ): boolean {
    const session = this.storage.getExpertSession(sessionId);
    if (!session) {
      logger.warn(`会话不存在: ${sessionId}`);
      return false;
    }

    // 状态保护：终态不可变更
    if (TERMINAL_STATES.includes(session.status)) {
      logger.warn(
        `会话 ${sessionId} 已处于终态(${session.status})，拒绝状态变更请求: ${status}`
      );
      return false;
    }

    // 计算持续时间
    if (status !== 'running' && session.execution.startedAt) {
      const now = new Date();
      session.execution.completedAt = now;
      session.execution.duration = now.getTime() - session.execution.startedAt.getTime();
    }

    session.status = status;
    if (result) {
      session.result = result;
    }

    this.storage.saveExpertSession(session);
    logger.info(`会话状态更新: ${sessionId} -> ${status}`);
    return true;
  }

  /**
   * 完成会话
   *
   * @returns true 表示成功更新状态，false 表示会话已处于终态
   */
  completeSession(
    sessionId: string,
    success: boolean,
    summary: string,
    details?: string,
    artifacts?: string[]
  ): boolean {
    const result: SessionResult = {
      success,
      summary,
      details,
      artifacts,
    };

    return this.updateSessionStatus(sessionId, success ? 'completed' : 'failed', result);
  }

  /**
   * 终止会话（用于超时等场景）
   *
   * @returns true 表示成功终止，false 表示会话已处于终态
   */
  terminateSession(
    sessionId: string,
    reason: string
  ): boolean {
    const result: SessionResult = {
      success: false,
      summary: `会话被终止: ${reason}`,
      details: reason,
    };

    return this.updateSessionStatus(sessionId, 'terminated', result);
  }

  /**
   * 更新会话的 Claude Session ID（用于 --resume）
   */
  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    const session = this.storage.getExpertSession(sessionId);
    if (!session) {
      logger.warn(`会话不存在: ${sessionId}`);
      return;
    }

    session.claudeSessionId = claudeSessionId;
    this.storage.saveExpertSession(session);
    logger.debug(`会话 ${sessionId} 关联 Claude 会话: ${claudeSessionId}`);
  }

  /**
   * 获取专家的会话目录
   */
  getExpertSessionDir(expertName: string): string {
    return path.join(this.expertsDir, expertName, 'sessions');
  }

  /**
   * 确保会话目录存在
   */
  private async ensureSessionDir(expertName: string): Promise<void> {
    const sessionDir = this.getExpertSessionDir(expertName);
    await fs.mkdir(sessionDir, { recursive: true });
  }

  /**
   * 清理旧会话
   */
  cleanupOldSessions(): number {
    const count = this.storage.cleanupOldSessions(this.sessionRetentionDays);
    if (count > 0) {
      logger.info(`清理了 ${count} 个过期会话`);
    }
    return count;
  }

  /**
   * 获取会话统计
   */
  getSessionStats(expertId?: string): {
    total: number;
    running: number;
    completed: number;
    failed: number;
  } {
    let sessions: ExpertSession[];

    if (expertId) {
      sessions = this.storage.getExpertSessions(expertId, 1000);
    } else {
      sessions = this.storage.getAllExpertSessions(1000);
    }

    return {
      total: sessions.length,
      running: sessions.filter(s => s.status === 'running').length,
      completed: sessions.filter(s => s.status === 'completed').length,
      failed: sessions.filter(s => s.status === 'failed').length,
    };
  }

  /**
   * 导出会话历史（用于调试）
   */
  async exportSessionHistory(expertName: string): Promise<string> {
    const sessions = await this.getExpertSessionsByName(expertName);
    const lines: string[] = [`# ${expertName} 会话历史`, ''];

    for (const session of sessions) {
      const statusEmoji = session.status === 'completed' ? '✅' :
                          session.status === 'failed' ? '❌' : '🔄';
      lines.push(`## ${statusEmoji} ${session.id}`);
      lines.push(`- 任务: ${session.task.description}`);
      lines.push(`- 状态: ${session.status}`);
      lines.push(`- 开始: ${session.execution.startedAt.toISOString()}`);

      if (session.execution.completedAt) {
        lines.push(`- 完成: ${session.execution.completedAt.toISOString()}`);
        lines.push(`- 耗时: ${session.execution.duration}ms`);
      }

      if (session.result) {
        lines.push(`- 结果: ${session.result.summary}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 通过专家名称获取会话
   */
  private async getExpertSessionsByName(expertName: string): Promise<ExpertSession[]> {
    // 从数据库获取专家的所有会话
    const allSessions = this.storage.getAllExpertSessions(1000);
    return allSessions.filter(s => s.expertName === expertName);
  }
}
