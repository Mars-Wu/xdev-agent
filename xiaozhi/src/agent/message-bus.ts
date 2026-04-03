// src/agent/message-bus.ts
// 消息传递系统 - 进程内 Agent 通信

import { createLogger } from '../utils/logger';
import { EventEmitter } from 'events';

const logger = createLogger('message-bus');

/**
 * Agent 消息类型
 */
export enum MessageType {
  /** 直接消息 */
  DIRECT = 'direct',
  /** 广播消息 */
  BROADCAST = 'broadcast',
  /** 任务分配 */
  TASK = 'task',
  /** 任务结果 */
  RESULT = 'result',
  /** 发现分享 */
  DISCOVERY = 'discovery',
  /** 决策请求 */
  DECISION_REQUEST = 'decision_request',
  /** 决策响应 */
  DECISION_RESPONSE = 'decision_response',
  /** 状态更新 */
  STATUS = 'status',
  /** 关闭信号 */
  SHUTDOWN = 'shutdown',
}

/**
 * Agent 消息
 */
export interface AgentMessage {
  /** 消息 ID */
  id: string;
  /** 消息类型 */
  type: MessageType;
  /** 发送者 */
  from: string;
  /** 接收者（广播时为 '*'） */
  to: string;
  /** 消息内容 */
  content: string | Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
  /** 关联的消息 ID（用于回复） */
  replyTo?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 消息处理器
 */
export type MessageHandler = (message: AgentMessage) => Promise<void> | void;

/**
 * 消息总线
 */
export class MessageBus extends EventEmitter {
  private handlers: Map<string, MessageHandler[]> = new Map();
  private messageHistory: AgentMessage[] = [];
  private maxHistorySize: number = 1000;
  private messageIdCounter: number = 0;

  constructor() {
    super();
  }

  /**
   * 注册消息处理器
   */
  register(agentId: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(agentId) || [];
    handlers.push(handler);
    this.handlers.set(agentId, handlers);
    logger.debug(`注册消息处理器: ${agentId}`);
  }

  /**
   * 注销消息处理器
   */
  unregister(agentId: string): void {
    this.handlers.delete(agentId);
    logger.debug(`注销消息处理器: ${agentId}`);
  }

  /**
   * 发送消息
   */
  async send(message: Omit<AgentMessage, 'id' | 'timestamp'>): Promise<void> {
    const fullMessage: AgentMessage = {
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    // 记录历史
    this.addToHistory(fullMessage);

    // 发出事件
    this.emit('message', fullMessage);

    // 分发消息
    if (message.to === '*') {
      // 广播
      await this.broadcast(fullMessage);
    } else {
      // 直接发送
      await this.deliver(fullMessage);
    }
  }

  /**
   * 投递消息
   */
  private async deliver(message: AgentMessage): Promise<void> {
    const handlers = this.handlers.get(message.to);
    if (!handlers || handlers.length === 0) {
      logger.warn(`没有找到接收者: ${message.to}`);
      return;
    }

    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (error) {
        logger.error(`处理消息失败 (${message.id}):`, error);
      }
    }
  }

  /**
   * 广播消息
   */
  private async broadcast(message: AgentMessage): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [agentId, handlers] of this.handlers) {
      // 不发送给自己
      if (agentId === message.from) {
        continue;
      }

      for (const handler of handlers) {
        promises.push(
          (async () => {
            try {
              await handler(message);
            } catch (error) {
              logger.error(`广播消息失败 (${agentId}):`, error);
            }
          })()
        );
      }
    }

    await Promise.all(promises);
  }

  /**
   * 发送并等待回复
   */
  async sendAndWait(
    message: Omit<AgentMessage, 'id' | 'timestamp'>,
    timeout: number = 30000
  ): Promise<AgentMessage | null> {
    const fullMessage = await this.prepareMessage(message);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('message', handler);
        resolve(null);
      }, timeout);

      const handler = (msg: AgentMessage) => {
        if (msg.replyTo === fullMessage.id) {
          clearTimeout(timer);
          this.off('message', handler);
          resolve(msg);
        }
      };

      this.on('message', handler);
      this.send(message);
    });
  }

  /**
   * 准备消息
   */
  private async prepareMessage(
    message: Omit<AgentMessage, 'id' | 'timestamp'>
  ): Promise<AgentMessage> {
    return {
      ...message,
      id: this.generateId(),
      timestamp: Date.now(),
    };
  }

  /**
   * 添加到历史
   */
  private addToHistory(message: AgentMessage): void {
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }
  }

  /**
   * 获取消息历史
   */
  getHistory(agentId?: string, limit: number = 100): AgentMessage[] {
    let history = this.messageHistory;

    if (agentId) {
      history = history.filter(
        m => m.from === agentId || m.to === agentId || m.to === '*'
      );
    }

    return history.slice(-limit);
  }

  /**
   * 清除历史
   */
  clearHistory(): void {
    this.messageHistory = [];
  }

  /**
   * 生成消息 ID
   */
  private generateId(): string {
    return `msg-${Date.now()}-${++this.messageIdCounter}`;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalMessages: number;
    registeredAgents: number;
    messagesByType: Record<string, number>;
  } {
    const messagesByType: Record<string, number> = {};

    for (const msg of this.messageHistory) {
      // 直接使用枚举值作为字符串
      const type = String(msg.type);
      messagesByType[type] = (messagesByType[type] || 0) + 1;
    }

    return {
      totalMessages: this.messageHistory.length,
      registeredAgents: this.handlers.size,
      messagesByType,
    };
  }
}

// 单例
let messageBus: MessageBus | null = null;

/**
 * 获取消息总线
 */
export function getMessageBus(): MessageBus {
  if (!messageBus) {
    messageBus = new MessageBus();
  }
  return messageBus;
}

/**
 * 重置消息总线
 */
export function resetMessageBus(): void {
  if (messageBus) {
    messageBus.removeAllListeners();
    messageBus.clearHistory();
  }
  messageBus = null;
}
