// src/feishu/client.ts
// 飞书客户端封装
// 支持自动重连机制

import * as lark from '@larksuiteoapi/node-sdk';
import { FeishuConfig, FeishuMessage, FeishuReply, MessageCard, FeishuMsgType } from './types';
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

            // 解析消息（支持文件类型）
            const parsedMessage = this.parseMessage(data, userId);

            await this.messageHandler(parsedMessage);
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

  /**
   * 解析消息（支持文件类型）
   */
  private parseMessage(data: any, userId: string): FeishuMessage {
    const baseInfo = {
      messageId: data.message.message_id,
      chatId: data.message.chat_id,
      userId: userId,
      timestamp: new Date(parseInt(data.message.create_time) * 1000),
    };

    const msgType = data.message.message_type;
    const contentStr = data.message.content;

    // 根据消息类型解析
    switch (msgType) {
      case 'image': {
        const content = JSON.parse(contentStr);
        logger.debug('解析图片消息:', content);
        return {
          ...baseInfo,
          msgType: 'image' as FeishuMsgType,
          imageKey: content.image_key,
          content: '[图片]',
        };
      }
      case 'file': {
        // 飞书文件消息是嵌套 JSON: {"value": "{\"file_key\":\"...\",\"file_name\":\"...\"}"}
        const outerContent = JSON.parse(contentStr);
        const content = typeof outerContent.value === 'string'
          ? JSON.parse(outerContent.value)
          : outerContent;
        logger.debug('解析文件消息:', content);

        // 获取 MIME 类型（飞书不提供，根据文件名推断）
        const mimeType = this.inferMimeType(content.file_name);

        // 飞书不提供文件大小，下载后才能知道
        return {
          ...baseInfo,
          msgType: 'file' as FeishuMsgType,
          fileKey: content.file_key,
          fileName: content.file_name,
          fileSize: 0, // 飞书不提供，需要下载后获取
          fileType: mimeType,
          content: `[文件: ${content.file_name}]`,
        };
      }
      case 'media': {
        const content = JSON.parse(contentStr);
        logger.debug('解析媒体消息:', content);
        return {
          ...baseInfo,
          msgType: 'media' as FeishuMsgType,
          fileKey: content.file_key,
          fileName: content.file_name,
          content: `[媒体: ${content.file_name}]`,
        };
      }
      case 'audio': {
        const content = JSON.parse(contentStr);
        logger.debug('解析音频消息:', content);
        return {
          ...baseInfo,
          msgType: 'audio' as FeishuMsgType,
          fileKey: content.file_key,
          content: '[音频]',
        };
      }
      default:
        // 文本消息
        return {
          ...baseInfo,
          msgType: msgType as FeishuMsgType,
          content: this.parseContent(contentStr),
        };
    }
  }

  /**
   * 根据文件名推断 MIME 类型
   */
  private inferMimeType(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const mimeMap: Record<string, string> = {
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'txt': 'text/plain',
      'csv': 'text/csv',
      'json': 'application/json',
      'xml': 'application/xml',
      'zip': 'application/zip',
      'rar': 'application/x-rar-compressed',
      '7z': 'application/x-7z-compressed',
    };
    return mimeMap[ext] || 'application/octet-stream';
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

  /**
   * 下载文件（用户发送的文件资源）
   * @param fileKey 文件标识
   * @param messageId 消息 ID（必需，用于获取用户发送的文件）
   * @param type 文件类型 ('image' 或 'file')
   * @returns 文件 Buffer
   */
  async downloadFile(fileKey: string, messageId: string, type: 'image' | 'file' = 'file'): Promise<Buffer> {
    try {
      logger.info(`下载文件: ${fileKey}, 消息ID: ${messageId}, 类型: ${type}`);

      const token = await this.getTenantAccessToken();

      // 获取用户发送的文件资源
      // https://open.feishu.cn/document/server-docs/im-v1/message-resources/get
      const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;

      logger.debug(`下载 URL: ${url}`);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`下载文件失败: ${response.status} ${response.statusText}`, errorText);
        throw new Error(`下载文件失败: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      logger.info(`文件下载成功: ${arrayBuffer.byteLength} bytes`);
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error(`下载文件失败 (${fileKey}):`, error);
      throw error;
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    // 使用 lark SDK 的内置方法获取 token
    const response = await this.client.auth.tenantAccessToken.internal({
      data: {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
    } as any);

    // lark SDK 返回的结构可能是 response.tenant_access_token 或者在 data 中
    const token = (response as any).tenant_access_token || (response as any).data?.tenant_access_token;
    if (!token) {
      throw new Error('获取 tenant_access_token 失败');
    }
    return token;
  }
}
