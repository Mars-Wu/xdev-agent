// src/session/types.ts
// 会话相关类型定义

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export type SessionStatus = 'active' | 'archived' | 'deleted';

export interface SessionContext {
  conversationHistory: Message[];
  activeWorkers: string[];
  taskContext: Record<string, unknown>;
  summary?: string; // 历史对话摘要
}

export interface SessionSettings {
  notifyOnProgress: boolean;
  progressNotifyInterval: number; // 秒
  maxWorkers: number;
  defaultTimeout: number; // 秒
}

export interface Session {
  id: string;
  name: string;
  userId: string;
  feishuChatId: string;
  status: SessionStatus;
  context: SessionContext;
  settings: SessionSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionManagerConfig {
  maxContextMessages: number;
  compressThreshold: number;
}
