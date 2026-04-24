// src/plugin-sdk/types.ts
// 插件 SDK 核心类型定义
// 参考 OpenClaw 的 plugin-sdk 设计

import { createLogger } from '../utils/logger';

/**
 * 插件类型
 */
export type PluginType = 'channel' | 'skill' | 'provider' | 'utility';

/**
 * 插件状态
 */
export type PluginStatus = 'unloaded' | 'loading' | 'loaded' | 'error' | 'disabled';

/**
 * 插件元数据
 */
export interface PluginMetadata {
  // 插件 ID（唯一标识）
  id: string;
  // 插件名称
  name: string;
  // 插件版本
  version: string;
  // 插件描述
  description: string;
  // 插件类型
  type: PluginType;
  // 作者
  author?: string;
  // 主入口文件
  main: string;
  // 依赖的其他插件
  dependencies?: string[];
  // 配置 Schema
  configSchema?: PluginConfigSchema;
}

/**
 * 插件配置 Schema
 */
export interface PluginConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required?: boolean;
    default?: unknown;
    description?: string;
  };
}

/**
 * 插件配置
 */
export interface PluginConfig {
  // 是否启用
  enabled: boolean;
  // 插件特定配置
  [key: string]: unknown;
}

/**
 * 插件上下文 - 插件运行时可以访问的 API
 */
export interface PluginContext {
  // 日志记录器
  logger: ReturnType<typeof createLogger>;
  // 获取配置
  getConfig: () => PluginConfig;
  // 更新配置
  updateConfig: (config: Partial<PluginConfig>) => void;
  // 发送事件
  emit: (event: string, data: unknown) => void;
  // 监听事件
  on: (event: string, handler: (data: unknown) => void) => () => void;
  // 访问存储
  storage: PluginStorage;
}

/**
 * 插件存储接口
 */
export interface PluginStorage {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * 插件接口 - 所有插件必须实现
 */
export interface XdevPlugin {
  // 插件元数据
  metadata: PluginMetadata;

  // 初始化（可选）
  setup?: (context: PluginContext) => Promise<void>;

  // 清理（可选）
  teardown?: () => Promise<void>;

  // 处理消息（可选，通道插件实现）
  handleMessage?: (message: PluginMessage) => Promise<PluginResponse | null>;

  // 处理命令（可选，技能插件实现）
  handleCommand?: (command: string, args: string[]) => Promise<PluginResponse | null>;
}

/**
 * 插件消息
 */
export interface PluginMessage {
  // 消息 ID
  id: string;
  // 来源（如 'feishu', 'telegram'）
  source: string;
  // 发送者 ID
  senderId: string;
  // 发送者名称
  senderName?: string;
  // 消息类型
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'event';
  // 消息内容
  content: string;
  // 附加数据
  data?: Record<string, unknown>;
  // 时间戳
  timestamp: Date;
  // 回复地址（用于发送回复）
  replyTo?: {
    type: 'chat' | 'user';
    id: string;
  };
}

/**
 * 插件响应
 */
export interface PluginResponse {
  // 是否处理成功
  success: boolean;
  // 响应内容
  content?: string;
  // 附加数据
  data?: Record<string, unknown>;
  // 是否继续传递给下一个插件
  continuePropagation?: boolean;
  // 错误信息
  error?: string;
}

/**
 * 通道插件接口（扩展）
 */
export interface ChannelPlugin extends XdevPlugin {
  // 通道能力
  capabilities: {
    send: boolean;
    receive: boolean;
    edit?: boolean;
    delete?: boolean;
    reply?: boolean;
    typing?: boolean;
    files?: boolean;
  };

  // 发送消息
  sendMessage: (target: string, content: string, options?: SendMessageOptions) => Promise<void>;

  // 启动通道
  start?: () => Promise<void>;

  // 停止通道
  stop?: () => Promise<void>;

  // 获取通道状态
  getStatus?: () => Promise<ChannelStatus>;
}

/**
 * 发送消息选项
 */
export interface SendMessageOptions {
  // 消息类型
  type?: 'text' | 'markdown' | 'card';
  // 引用消息 ID
  replyTo?: string;
  // 附件
  attachments?: MessageAttachment[];
}

/**
 * 消息附件
 */
export interface MessageAttachment {
  type: 'image' | 'file' | 'audio' | 'video';
  url?: string;
  path?: string;
  name?: string;
  size?: number;
}

/**
 * 通道状态
 */
export interface ChannelStatus {
  connected: boolean;
  lastActive?: Date;
  error?: string;
  metrics?: {
    messagesReceived: number;
    messagesSent: number;
    errors: number;
  };
}

/**
 * 插件加载结果
 */
export interface PluginLoadResult {
  success: boolean;
  plugin?: XdevPlugin;
  error?: string;
}

/**
 * 插件管理器接口
 */
export interface PluginManager {
  // 加载插件
  load: (pluginPath: string) => Promise<PluginLoadResult>;

  // 卸载插件
  unload: (pluginId: string) => Promise<boolean>;

  // 获取插件
  get: (pluginId: string) => XdevPlugin | undefined;

  // 获取所有插件
  getAll: () => XdevPlugin[];

  // 获取插件状态
  getStatus: (pluginId: string) => PluginStatus;

  // 启用/禁用插件
  setEnabled: (pluginId: string, enabled: boolean) => Promise<boolean>;
}
