// src/feishu/client.ts
// 飞书客户端封装

import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuConfig, FeishuMessage, FeishuReply, MessageCard } from './types';

export class FeishuClient {
  private client: lark.Client;
  private wsClient?: lark.WSClient;
  private messageHandler?: (msg: FeishuMessage) => Promise<void>;
  private processedMessages: Set<string> = new Set();
  private readonly MESSAGE_CACHE_SIZE = 1000;

  constructor(config: FeishuConfig) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    // 长连接模式（开发推荐）
    if (config.useWebSocket !== false) {
      this.wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });
    }
  }

  setMessageHandler(handler: (msg: FeishuMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.wsClient) {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          if (this.messageHandler) {
            // 消息去重
            const messageId = data.message.message_id;
            if (this.processedMessages.has(messageId)) {
              console.log('[DEBUG] Duplicate message ignored:', messageId);
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

      await this.wsClient.start({ eventDispatcher });
      console.log('Feishu WebSocket client started');
    }
  }

  async stop(): Promise<void> {
    // WSClient does not have a stop method in this SDK version
    // The connection will be closed when the process exits
    console.log('Feishu WebSocket client stopping');
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
      console.error('Failed to send message:', error);
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
      console.error('Failed to send card:', error);
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
      console.error('Failed to reply to message:', error);
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
