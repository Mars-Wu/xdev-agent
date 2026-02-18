// src/feishu/types.ts
// 飞书消息相关类型定义

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  userId: string;
  content: string;
  msgType: 'text' | 'post' | 'interactive';
  timestamp: Date;
}

export interface FeishuReply {
  content: string;
  type: 'text' | 'markdown' | 'interactive';
  card?: MessageCard;
}

export interface MessageCard {
  header?: {
    title: { content: string; tag: 'plain_text' };
    template?: string;
  };
  elements: Array<{
    tag: string;
    content?: string;
    [key: string]: unknown;
  }>;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  useWebSocket?: boolean;
  webhookPath?: string;
}
