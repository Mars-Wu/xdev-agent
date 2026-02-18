// src/session/manager.ts
// 会话管理器

import { Session, SessionContext, SessionSettings, Message, SessionManagerConfig } from './types';
import { SQLiteStorage } from '../storage/sqlite';

export class SessionManager {
  private storage: SQLiteStorage;
  private config: SessionManagerConfig;

  constructor(storage: SQLiteStorage, config?: Partial<SessionManagerConfig>) {
    this.storage = storage;
    this.config = {
      maxContextMessages: config?.maxContextMessages || 50,
      compressThreshold: config?.compressThreshold || 40,
    };
  }

  async getOrCreate(userId: string, chatId: string): Promise<Session> {
    // 先尝试通过chatId查找现有会话
    const existingRecord = this.storage.getSessionByChatId(chatId);
    if (existingRecord) {
      return this.recordToSession(existingRecord);
    }

    // 创建新会话
    const session: Session = {
      id: this.generateId(),
      name: `Session-${chatId.slice(0, 8)}`,
      userId,
      feishuChatId: chatId,
      status: 'active',
      context: {
        conversationHistory: [],
        activeWorkers: [],
        taskContext: {},
      },
      settings: {
        notifyOnProgress: true,
        progressNotifyInterval: 30,
        maxWorkers: 5,
        defaultTimeout: 3600,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.storage.saveSession({
      id: session.id,
      name: session.name,
      userId: session.userId,
      feishuChatId: session.feishuChatId,
      status: session.status,
      context: JSON.stringify(session.context),
      settings: JSON.stringify(session.settings),
    });

    return session;
  }

  async get(sessionId: string): Promise<Session | null> {
    const record = this.storage.getSession(sessionId);
    if (!record) return null;
    return this.recordToSession(record);
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;

    session.context.conversationHistory.push({
      ...message,
      timestamp: message.timestamp || new Date(),
    });

    this.storage.updateSessionContext(
      sessionId,
      JSON.stringify(session.context)
    );
  }

  async addWorker(sessionId: string, workerId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;

    if (!session.context.activeWorkers.includes(workerId)) {
      session.context.activeWorkers.push(workerId);
      this.storage.updateSessionContext(
        sessionId,
        JSON.stringify(session.context)
      );
    }
  }

  async removeWorker(sessionId: string, workerId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;

    session.context.activeWorkers = session.context.activeWorkers.filter(
      (id) => id !== workerId
    );
    this.storage.updateSessionContext(
      sessionId,
      JSON.stringify(session.context)
    );
  }

  async compressHistory(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;

    const history = session.context.conversationHistory;
    if (history.length <= this.config.compressThreshold) return;

    // 保留最近的消息，将旧消息压缩为摘要
    const recentMessages = history.slice(-20);
    const oldMessages = history.slice(0, -20);

    // 生成摘要（简单实现：提取用户消息的关键点）
    const summaryPoints = oldMessages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.slice(0, 100))
      .join('\n- ');

    session.context.summary = `历史对话摘要:\n- ${summaryPoints}`;
    session.context.conversationHistory = recentMessages;

    this.storage.updateSessionContext(
      sessionId,
      JSON.stringify(session.context)
    );
  }

  shouldCompress(session: Session): boolean {
    return (
      session.context.conversationHistory.length > this.config.maxContextMessages
    );
  }

  private recordToSession(record: {
    id: string;
    name: string;
    userId: string;
    feishuChatId: string;
    status: string;
    context: string;
    settings: string;
    createdAt: string;
    updatedAt: string;
  }): Session {
    return {
      id: record.id,
      name: record.name,
      userId: record.userId,
      feishuChatId: record.feishuChatId,
      status: record.status as Session['status'],
      context: JSON.parse(record.context) as SessionContext,
      settings: JSON.parse(record.settings) as SessionSettings,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
  }

  private generateId(): string {
    return (
      's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    );
  }
}
