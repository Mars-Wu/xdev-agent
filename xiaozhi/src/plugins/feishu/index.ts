// src/plugins/feishu/index.ts
// 飞书通道插件
// 实现 ChannelPlugin 接口，封装 FeishuClient

import {
  ChannelPlugin,
  PluginMetadata,
  PluginContext,
  ChannelStatus,
  SendMessageOptions,
  PluginMessage,
  PluginResponse,
} from '../../plugin-sdk/types';
import { FeishuClient } from '../../feishu/client';
import { FeishuMessage } from '../../feishu/types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('plugin:feishu');

/**
 * 飞书插件配置
 */
export interface FeishuPluginConfig {
  appId: string;
  appSecret: string;
  useWebSocket?: boolean;
}

/**
 * 飞书插件元数据
 */
const FEISHU_METADATA: PluginMetadata = {
  id: 'feishu',
  name: 'Feishu Channel',
  version: '1.0.0',
  description: '飞书消息通道插件',
  type: 'channel',
  author: 'Xiaozhi',
  main: 'index.js',
};

/**
 * 创建飞书通道插件
 */
export function createFeishuPlugin(config: FeishuPluginConfig): ChannelPlugin & {
  setMessageHandler: (handler: (message: PluginMessage) => Promise<PluginResponse | null>) => void;
  getClient: () => FeishuClient | null;
} {
  let client: FeishuClient | null = null;
  let context: PluginContext | null = null;
  let messageHandler: ((message: PluginMessage) => Promise<PluginResponse | null>) | null = null;

  // 统计信息
  const stats = {
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
    lastActive: new Date(),
  };

  // 转换飞书消息为插件消息
  function convertMessage(msg: FeishuMessage): PluginMessage {
    return {
      id: msg.messageId,
      source: 'feishu',
      senderId: msg.userId,
      senderName: undefined,
      type: msg.msgType === 'text' ? 'text' : 'event',
      content: msg.content,
      timestamp: msg.timestamp,
      replyTo: msg.chatId ? { type: 'chat', id: msg.chatId } : undefined,
      data: {
        chatId: msg.chatId,
        msgType: msg.msgType,
        imageKey: msg.imageKey,   // 图片消息专用
        fileKey: msg.fileKey,
        fileName: msg.fileName,
        fileType: msg.fileType,
      },
    };
  }

  return {
    metadata: FEISHU_METADATA,

    capabilities: {
      send: true,
      receive: true,
      edit: false,
      delete: false,
      reply: true,
      typing: false,
      files: true,
    },

    async setup(ctx: PluginContext) {
      context = ctx;
      logger.info('飞书插件初始化中...');
    },

    async teardown() {
      if (client) {
        await client.stop();
        client = null;
      }
      logger.info('飞书插件已关闭');
    },

    async start() {
      if (!context) {
        throw new Error('插件未初始化');
      }

      client = new FeishuClient({
        appId: config.appId,
        appSecret: config.appSecret,
        useWebSocket: config.useWebSocket ?? true,
      });

      // 设置消息处理器
      client.setMessageHandler(async (msg: FeishuMessage) => {
        stats.messagesReceived++;
        stats.lastActive = new Date();

        const pluginMessage = convertMessage(msg);

        // 发送事件
        context?.emit('message:received', pluginMessage);

        // 调用注册的消息处理器
        if (messageHandler) {
          try {
            await messageHandler(pluginMessage);
          } catch (error) {
            stats.errors++;
            logger.error('消息处理错误:', error);
          }
        }
      });

      await client.start();
      logger.info('飞书客户端已启动');
    },

    async stop() {
      if (client) {
        await client.stop();
        client = null;
        logger.info('飞书客户端已停止');
      }
    },

    async getStatus(): Promise<ChannelStatus> {
      return {
        connected: client !== null,
        lastActive: stats.lastActive,
        metrics: {
          messagesReceived: stats.messagesReceived,
          messagesSent: stats.messagesSent,
          errors: stats.errors,
        },
      };
    },

    async sendMessage(target: string, content: string, options?: SendMessageOptions): Promise<void> {
      if (!client) {
        throw new Error('飞书客户端未连接');
      }

      try {
        await client.sendMessage(target, {
          content,
          type: options?.type === 'markdown' ? 'markdown' : 'text',
        });
        stats.messagesSent++;
        stats.lastActive = new Date();
      } catch (error) {
        stats.errors++;
        throw error;
      }
    },

    async handleMessage(message: PluginMessage): Promise<PluginResponse | null> {
      // 飞书插件不直接处理消息，由消息处理器处理
      if (messageHandler) {
        return messageHandler(message);
      }
      return null;
    },

    // 扩展方法

    setMessageHandler(handler: (message: PluginMessage) => Promise<PluginResponse | null>) {
      messageHandler = handler;
    },

    getClient(): FeishuClient | null {
      return client;
    },
  };
}

// 默认导出
export default {
  metadata: FEISHU_METADATA,
  create: createFeishuPlugin,
};
