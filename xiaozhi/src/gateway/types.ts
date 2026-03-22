// src/gateway/types.ts
// Gateway 类型定义
// 参考 OpenClaw 的 Gateway 协议设计

/**
 * Gateway 配置
 */
export interface GatewayConfig {
  // 绑定地址
  host: string;
  // 端口
  port: number;
  // 认证令牌（可选）
  authToken?: string;
  // 是否启用 TLS
  tls?: {
    cert: string;
    key: string;
  };
  // 最大连接数
  maxConnections?: number;
  // 心跳间隔（毫秒）
  heartbeatInterval?: number;
  // 连接超时（毫秒）
  connectionTimeout?: number;
}

/**
 * 客户端连接信息
 */
export interface ClientConnection {
  // 连接 ID
  id: string;
  // 客户端类型
  type: 'cli' | 'web' | 'mobile' | 'channel';
  // 客户端名称
  name?: string;
  // 连接时间
  connectedAt: Date;
  // 最后活跃时间
  lastActiveAt: Date;
  // 远程地址
  remoteAddress?: string;
  // 用户代理
  userAgent?: string;
  // 认证信息
  auth?: {
    userId?: string;
    token?: string;
    scopes?: string[];
  };
}

/**
 * Gateway 方法请求
 */
export interface GatewayRequest {
  // 请求 ID
  id: string;
  // 方法名
  method: string;
  // 参数
  params?: Record<string, unknown>;
  // 时间戳
  timestamp: number;
}

/**
 * Gateway 方法响应
 */
export interface GatewayResponse {
  // 请求 ID（对应请求）
  id: string;
  // 是否成功
  success: boolean;
  // 结果数据
  result?: unknown;
  // 错误信息
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Gateway 事件
 */
export interface GatewayEvent {
  // 事件类型
  type: string;
  // 事件数据
  data: unknown;
  // 时间戳
  timestamp: number;
  // 来源（可选）
  source?: string;
}

/**
 * Gateway 状态
 */
export interface GatewayStatus {
  // 是否运行中
  running: boolean;
  // 启动时间
  startedAt?: Date;
  // 连接数
  connections: number;
  // 活跃会话数
  activeSessions: number;
  // 运行时长（秒）
  uptime?: number;
  // 版本
  version: string;
}

/**
 * 方法处理器
 */
export type MethodHandler = (
  params: Record<string, unknown>,
  client: ClientConnection
) => Promise<unknown> | unknown;

/**
 * 方法定义
 */
export interface MethodDefinition {
  // 方法名
  name: string;
  // 描述
  description?: string;
  // 参数 Schema
  paramsSchema?: Record<string, unknown>;
  // 返回值 Schema
  resultSchema?: Record<string, unknown>;
  // 是否需要认证
  requiresAuth?: boolean;
  // 权限范围
  scopes?: string[];
  // 处理器
  handler: MethodHandler;
}

/**
 * Gateway 消息类型
 */
export type GatewayMessageType = 'request' | 'response' | 'event' | 'ping' | 'pong' | 'error';

/**
 * Gateway 消息
 */
export interface GatewayMessage {
  type: GatewayMessageType;
  payload: GatewayRequest | GatewayResponse | GatewayEvent | null;
}

/**
 * 内置方法名
 */
export const BuiltinMethods = {
  // 系统
  PING: 'ping',
  STATUS: 'status',
  SHUTDOWN: 'shutdown',

  // 对话
  CHAT: 'chat',
  CHAT_STREAM: 'chat.stream',

  // 会话
  SESSION_LIST: 'session.list',
  SESSION_GET: 'session.get',
  SESSION_ABORT: 'session.abort',

  // 消息
  MESSAGE_SEND: 'message.send',
  MESSAGE_HISTORY: 'message.history',

  // 配置
  CONFIG_GET: 'config.get',
  CONFIG_SET: 'config.set',

  // 插件
  PLUGIN_LIST: 'plugin.list',
  PLUGIN_STATUS: 'plugin.status',

  // 通道
  CHANNEL_STATUS: 'channel.status',
  CHANNEL_SEND: 'channel.send',
} as const;

/**
 * 错误代码
 */
export const ErrorCodes = {
  // 通用错误
  UNKNOWN: 'UNKNOWN',
  INVALID_REQUEST: 'INVALID_REQUEST',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',

  // 认证错误
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // 资源错误
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',

  // 状态错误
  INVALID_STATE: 'INVALID_STATE',
  RATE_LIMITED: 'RATE_LIMITED',

  // 服务器错误
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
