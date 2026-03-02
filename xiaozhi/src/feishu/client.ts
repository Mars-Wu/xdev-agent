// src/feishu/client.ts
// 飞书客户端封装
// 支持自动重连机制

import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuConfig, FeishuMessage, FeishuReply, MessageCard } from './types';
import { createLogger } from '../utils/logger';

const logger = createLogger('feishu');

// 重连配置
const RECONNECT_CONFIG = {
  maxRetries: 10,           // 最大重连次数
  initialDelay: 1000,       // 初始重连延迟 (ms)
  maxDelay: 30000,          // 最大重连延迟 (ms)
  backoffFactor: 2,         // 退避因子
};

export class FeishuClient {
  private client: lark.Client;
  private wsClient?: lark.WSClient;
  private config: FeishuConfig;
  private messageHandler?: (msg: FeishuMessage) => Promise<void>;
  private processedMessages: Set<string> = new Set();
  private readonly MESSAGE_CACHE_SIZE = 1000;

  // 重连状态
  private isReconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private currentDelay: number = RECONNECT_CONFIG.initialDelay;
  private reconnectTimer?: NodeJS.Timeout;
  private isShuttingDown: boolean = false;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    this.initWebSocket();
  }

  private initWebSocket(): void {
    if (this.config.useWebSocket !== false) {
      this.wsClient = new lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });
    }
  }

  setMessageHandler(handler: (msg: FeishuMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.wsClient) {
      await this.connectWithRetry();
    }
  }

  /**
   * 带重试的 WebSocket 连接
   */
  private async connectWithRetry(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          if (this.messageHandler) {
            // 消息去重
            const messageId = data.message.message_id;
            if (this.processedMessages.has(messageId)) {
              logger.debug('重复消息已忽略:', messageId);
              return;
            }

            // 添加到已处理集合
            this.processedMessages.add(messageId);
            // 限制缓存大小
            if (this.processedMessages.size > this.MESSAGE_CACHE_SIZE) {
              const first = this.processedMessages.values().next().value;
              if (first) this.processedMessages.delete(first);
            }

            // 获取用户ID (兼容不同的数据结构)
            const userId = data.sender?.sender_id?.user_id
              || data.sender?.sender_id?.open_id
              || 'unknown_user';

            await this.messageHandler({
              messageId: data.message.message_id,
              chatId: data.message.chat_id,
              userId: userId,
              content: this.parseContent(data.message.content),
              msgType: data.message.message_type as FeishuMessage['msgType'],
              timestamp: new Date(parseInt(data.message.create_time) * 1000),
            });
          }
        },
      });

      // WSClient 可能不支持事件监听，使用包装方式处理
      // 如果连接失败或断开，start() 会抛出异常
      await this.wsClient!.start({ eventDispatcher });

      // 连接成功，重置重连状态
      this.reconnectAttempts = 0;
      this.currentDelay = RECONNECT_CONFIG.initialDelay;
      this.isReconnecting = false;

      logger.info('WebSocket 客户端已启动');
    } catch (error) {
      logger.error('连接失败:', error);
      this.handleDisconnect();
    }
  }

  /**
   * 处理连接断开
   */
  private handleDisconnect(): void {
    if (this.isShuttingDown || this.isReconnecting) return;

    this.isReconnecting = true;

    if (this.reconnectAttempts >= RECONNECT_CONFIG.maxRetries) {
      logger.error(`已达到最大重连次数 (${RECONNECT_CONFIG.maxRetries})，停止重连`);
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    logger.info(`将在 ${this.currentDelay}ms 后进行第 ${this.reconnectAttempts} 次重连...`);

    this.reconnectTimer = setTimeout(async () => {
      logger.info(`开始第 ${this.reconnectAttempts} 次重连...`);

      // P1 修复：在创建新实例前显式关闭旧实例，避免资源泄漏
      if (this.wsClient) {
        try {
          // 尝试关闭旧的 WSClient（如果有关闭方法的话）
          // lark WSClient 可能没有显式的 close 方法，这里设置为 undefined 让 GC 回收
          this.wsClient = undefined;
          logger.debug('旧 WSClient 实例已释放');
        } catch (error) {
          logger.warn('关闭旧 WSClient 时出错:', error);
        }
      }

      // 重新创建 WSClient 实例
      this.initWebSocket();

      try {
        await this.connectWithRetry();
      } catch (error) {
        logger.error(`第 ${this.reconnectAttempts} 次重连失败:`, error);
      }

      // 指数退避
      this.currentDelay = Math.min(
        this.currentDelay * RECONNECT_CONFIG.backoffFactor,
        RECONNECT_CONFIG.maxDelay
      );
    }, this.currentDelay);
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    // 清除重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    logger.info('WebSocket 客户端正在停止');
  }

  async sendMessage(chatId: string, reply: FeishuReply): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: this.formatContent(reply),
          msg_type: reply.type === 'interactive' ? 'interactive' : 'text',
        },
      });
    } catch (error) {
      logger.error('发送消息失败:', error);
      throw error;
    }
  }

  async sendCard(chatId: string, card: MessageCard): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    } catch (error) {
      logger.error('发送卡片失败:', error);
      throw error;
    }
  }

  async replyToMessage(messageId: string, reply: FeishuReply): Promise<void> {
    try {
      await this.client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          content: this.formatContent(reply),
          msg_type: reply.type === 'interactive' ? 'interactive' : 'text',
        },
      });
    } catch (error) {
      logger.error('回复消息失败:', error);
      throw error;
    }
  }

  private parseContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      if (parsed.text) return parsed.text;
      return content;
    } catch {
      return content;
    }
  }

  private formatContent(reply: FeishuReply): string {
    if (reply.type === 'interactive' && reply.card) {
      return JSON.stringify(reply.card);
    }
    // 统一使用纯文本格式（飞书的 text 类型只接受 {text: "..."} 格式）
    return JSON.stringify({ text: reply.content });
  }
}
