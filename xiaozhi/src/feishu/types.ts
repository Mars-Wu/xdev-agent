// src/feishu/types.ts
// 飞书消息相关类型定义

// 扩展的消息类型
export type FeishuMsgType = 'text' | 'post' | 'interactive' | 'image' | 'file' | 'media' | 'audio';

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  userId: string;
  content: string;
  msgType: FeishuMsgType;
  timestamp: Date;
  // 文件相关字段
  fileKey?: string;        // 文件标识
  fileName?: string;       // 文件名
  fileSize?: number;       // 文件大小 (bytes)
  fileType?: string;       // MIME 类型
  imageKey?: string;       // 图片标识 (与 fileKey 互斥)
}

// 下载的文件信息
export interface DownloadedFile {
  localPath: string;       // 本地保存路径
  originalName: string;    // 原始文件名
  mimeType: string;        // MIME 类型
  size: number;            // 文件大小
  chatId: string;          // 来源聊天
  messageId: string;       // 来源消息
  fileId: string;          // 本地文件 ID
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

/**
 * 飞书原始消息事件数据
 */
export interface FeishuRawEventData {
  message: {
    message_id: string;
    chat_id: string;
    create_time: string;
    message_type: string;
    content: string;
  };
}

/**
 * 飞书文件消息内容
 */
export interface FeishuFileContent {
  file_key: string;
  file_name: string;
}

/**
 * 飞书图片消息内容
 */
export interface FeishuImageContent {
  image_key: string;
}

/**
 * 飞书 API 响应基础结构
 */
export interface FeishuApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

/**
 * 租户访问令牌响应
 */
export interface TenantAccessTokenResponse {
  tenant_access_token: string;
  expire: number;
}
