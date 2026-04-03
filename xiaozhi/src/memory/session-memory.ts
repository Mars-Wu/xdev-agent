// src/memory/session-memory.ts
// 会话记忆 - 结构化模板

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { SessionAction, SessionMemory } from './types';

const logger = createLogger('session-memory');

/**
 * 会话记忆管理器
 */
export class SessionMemoryManager {
  private sessionDir: string;
  private currentSession: SessionMemory | null = null;
  private sessionFile: string | null = null;

  constructor() {
    const home = process.env.XIAOZHI_HOME || path.join(os.homedir(), '.xiaozhi');
    this.sessionDir = path.join(home, 'memory', 'sessions');
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
  }

  /**
   * 开始新会话
   */
  async startSession(sessionId: string, sessionName?: string): Promise<SessionMemory> {
    this.currentSession = {
      sessionId,
      sessionName: sessionName || `会话 ${sessionId.slice(0, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      topicSummary: '',
      decisions: [],
      actions: [],
      extractedMemoryIds: [],
      context: {},
      tokenStats: { input: 0, output: 0, total: 0 },
    };

    this.sessionFile = path.join(this.sessionDir, `session-${sessionId}.md`);
    await this.saveSession();

    logger.info(`开始会话: ${sessionId}`);
    return this.currentSession;
  }

  /**
   * 获取当前会话
   */
  getCurrentSession(): SessionMemory | null {
    return this.currentSession;
  }

  /**
   * 记录操作
   */
  recordAction(action: Omit<SessionAction, 'timestamp'>): void {
    if (!this.currentSession) return;

    this.currentSession.actions.push({
      ...action,
      timestamp: Date.now(),
    });
    this.currentSession.updatedAt = Date.now();
  }

  /**
   * 记录决策
   */
  recordDecision(decision: string): void {
    if (!this.currentSession) return;

    this.currentSession.decisions.push(decision);
    this.currentSession.updatedAt = Date.now();
  }

  /**
   * 更新 Token 统计
   */
  updateTokenStats(input: number, output: number): void {
    if (!this.currentSession) return;

    this.currentSession.tokenStats.input += input;
    this.currentSession.tokenStats.output += output;
    this.currentSession.tokenStats.total += input + output;
    this.currentSession.updatedAt = Date.now();
  }

  /**
   * 增加消息计数
   */
  incrementMessageCount(): void {
    if (!this.currentSession) return;
    this.currentSession.messageCount++;
    this.currentSession.updatedAt = Date.now();
  }

  /**
   * 设置主题摘要
   */
  setTopicSummary(summary: string): void {
    if (!this.currentSession) return;
    this.currentSession.topicSummary = summary;
    this.currentSession.updatedAt = Date.now();
  }

  /**
   * 更新上下文
   */
  updateContext(context: Partial<SessionMemory['context']>): void {
    if (!this.currentSession) return;
    this.currentSession.context = {
      ...this.currentSession.context,
      ...context,
    };
    this.currentSession.updatedAt = Date.now();
  }

  /**
   * 添加已提取的记忆 ID
   */
  addExtractedMemoryId(memoryId: string): void {
    if (!this.currentSession) return;
    if (!this.currentSession.extractedMemoryIds.includes(memoryId)) {
      this.currentSession.extractedMemoryIds.push(memoryId);
    }
  }

  /**
   * 检查是否需要提取记忆
   */
  shouldExtractMemories(): boolean {
    if (!this.currentSession) return false;

    const { tokenStats, actions } = this.currentSession;

    // Token 阈值检查
    if (tokenStats.total >= 8000) return true;

    // 工具调用次数检查
    if (actions.length >= 10) return true;

    return false;
  }

  /**
   * 保存会话到文件
   */
  async saveSession(): Promise<void> {
    if (!this.currentSession || !this.sessionFile) return;

    const content = this.buildSessionMarkdown();
    await fs.writeFile(this.sessionFile, content, 'utf-8');
  }

  /**
   * 构建会话 Markdown
   */
  private buildSessionMarkdown(): string {
    if (!this.currentSession) return '';

    const session = this.currentSession;
    const lines: string[] = [
      `# 会话摘要 - ${session.sessionName}`,
      '',
      `**会话 ID**: ${session.sessionId}`,
      `**创建时间**: ${new Date(session.createdAt).toLocaleString()}`,
      `**更新时间**: ${new Date(session.updatedAt).toLocaleString()}`,
      '',
      '## 主题',
      session.topicSummary || '_暂无_',
      '',
      '## 关键决策',
      '',
    ];

    if (session.decisions.length === 0) {
      lines.push('_暂无_');
    } else {
      for (const decision of session.decisions) {
        lines.push(`- ${decision}`);
      }
    }

    lines.push('', '## 执行操作', '');

    if (session.actions.length === 0) {
      lines.push('_暂无_');
    } else {
      // 按类型分组
      const grouped = this.groupActionsByType(session.actions);
      for (const [type, actions] of Object.entries(grouped)) {
        lines.push(`### ${this.getActionTypeName(type)}`);
        for (const action of actions.slice(-10)) { // 最近 10 条
          const status = action.success ? '✅' : '❌';
          lines.push(`- ${status} ${action.description}`);
        }
      }
    }

    lines.push('', '## Token 统计', '');
    lines.push(`- 输入: ${session.tokenStats.input.toLocaleString()} tokens`);
    lines.push(`- 输出: ${session.tokenStats.output.toLocaleString()} tokens`);
    lines.push(`- 总计: ${session.tokenStats.total.toLocaleString()} tokens`);

    if (session.extractedMemoryIds.length > 0) {
      lines.push('', '## 提取的记忆', '');
      lines.push(`共 ${session.extractedMemoryIds.length} 条记忆已提取到长期存储`);
    }

    return lines.join('\n');
  }

  /**
   * 按类型分组操作
   */
  private groupActionsByType(
    actions: SessionAction[]
  ): Record<string, SessionAction[]> {
    const grouped: Record<string, SessionAction[]> = {};

    for (const action of actions) {
      if (!grouped[action.type]) {
        grouped[action.type] = [];
      }
      grouped[action.type].push(action);
    }

    return grouped;
  }

  /**
   * 获取操作类型名称
   */
  private getActionTypeName(type: string): string {
    const names: Record<string, string> = {
      bash: 'Shell 命令',
      read: '文件读取',
      write: '文件写入',
      edit: '文件编辑',
      search: '搜索',
      other: '其他',
    };
    return names[type] || type;
  }

  /**
   * 结束会话
   */
  async endSession(): Promise<string | null> {
    if (!this.currentSession) return null;

    // 生成最终摘要
    const summary = this.generateFinalSummary();
    await this.saveSession();

    logger.info(`会话结束: ${this.currentSession.sessionId}`);
    this.currentSession = null;
    this.sessionFile = null;

    return summary;
  }

  /**
   * 生成最终摘要
   */
  private generateFinalSummary(): string {
    if (!this.currentSession) return '';

    const session = this.currentSession;
    const lines: string[] = [
      `会话 "${session.sessionName}" 已结束`,
      `- 消息数: ${session.messageCount}`,
      `- 操作数: ${session.actions.length}`,
      `- 决策数: ${session.decisions.length}`,
      `- Token 使用: ${session.tokenStats.total.toLocaleString()}`,
    ];

    if (session.topicSummary) {
      lines.push(`- 主题: ${session.topicSummary}`);
    }

    return lines.join('\n');
  }

  /**
   * 加载历史会话
   */
  async loadSession(sessionId: string): Promise<SessionMemory | null> {
    const file = path.join(this.sessionDir, `session-${sessionId}.md`);
    try {
      const content = await fs.readFile(file, 'utf-8');
      const session = this.parseSessionMarkdown(content);
      if (session) {
        this.currentSession = session;
        this.sessionFile = file;
      }
      return session;
    } catch {
      return null;
    }
  }

  /**
   * 解析会话 Markdown
   */
  private parseSessionMarkdown(content: string): SessionMemory | null {
    // 简单解析，提取基本信息
    const sessionIdMatch = content.match(/\*\*会话 ID\*\*:\s*(\S+)/);
    const sessionNameMatch = content.match(/^# 会话摘要 - (.+)$/m);

    if (!sessionIdMatch) return null;

    return {
      sessionId: sessionIdMatch[1],
      sessionName: sessionNameMatch?.[1] || '未知会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      topicSummary: '',
      decisions: [],
      actions: [],
      extractedMemoryIds: [],
      context: {},
      tokenStats: { input: 0, output: 0, total: 0 },
    };
  }

  /**
   * 列出最近的会话
   */
  async listRecentSessions(limit: number = 10): Promise<Array<{
    sessionId: string;
    sessionName: string;
    updatedAt: Date;
    file: string;
  }>> {
    try {
      const files = await fs.readdir(this.sessionDir);
      const sessions = files
        .filter(f => f.startsWith('session-') && f.endsWith('.md'))
        .map(f => ({
          file: f,
          sessionId: f.replace('session-', '').replace('.md', ''),
        }));

      // 获取修改时间
      const withStats = await Promise.all(
        sessions.map(async (s) => {
          const filePath = path.join(this.sessionDir, s.file);
          const stat = await fs.stat(filePath);
          return {
            ...s,
            sessionName: s.sessionId.slice(0, 8),
            updatedAt: stat.mtime,
          };
        })
      );

      // 按修改时间排序
      withStats.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      return withStats.slice(0, limit);
    } catch {
      return [];
    }
  }
}

// 单例
let sessionMemoryManager: SessionMemoryManager | null = null;

/**
 * 获取会话记忆管理器
 */
export function getSessionMemoryManager(): SessionMemoryManager {
  if (!sessionMemoryManager) {
    sessionMemoryManager = new SessionMemoryManager();
  }
  return sessionMemoryManager;
}
