// src/gateway/server.ts
// Gateway WebSocket 服务器
// 提供控制平面 API

import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createLogger } from '../utils/logger';
import { EventBus, eventBus, EventTypes } from '../plugin-sdk/event-bus';
import {
  GatewayConfig,
  GatewayRequest,
  GatewayResponse,
  GatewayEvent,
  GatewayStatus,
  ClientConnection,
  MethodHandler,
  MethodDefinition,
  GatewayMessage,
  BuiltinMethods,
  ErrorCodes,
} from './types';

const logger = createLogger('gateway');

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Partial<GatewayConfig> = {
  host: '127.0.0.1',
  port: 18789,
  maxConnections: 100,
  heartbeatInterval: 30000,
  connectionTimeout: 60000,
};

/**
 * Gateway 服务器
 *
 * WebSocket 控制平面，提供实时 API 和事件推送。
 */
export class GatewayServer {
  private config: Required<GatewayConfig>;
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private methods: Map<string, MethodDefinition> = new Map();
  private clients: Map<string, ClientConnection> = new Map();
  private clientSockets: Map<string, WebSocket> = new Map();
  private startedAt: Date | null = null;
  private requestCounter: number = 0;

  constructor(config: Partial<GatewayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<GatewayConfig>;
    this.registerBuiltinMethods();
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 创建 HTTP 服务器
        this.httpServer = http.createServer((req, res) => {
          this.handleHttpRequest(req, res);
        });

        // 创建 WebSocket 服务器
        this.wsServer = new WebSocketServer({ server: this.httpServer });

        this.wsServer.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });

        this.wsServer.on('error', (error) => {
          logger.error('WebSocket 服务器错误:', error);
        });

        // 开始监听
        this.httpServer.listen(this.config.port, this.config.host, () => {
          this.startedAt = new Date();
          logger.info(`Gateway 已启动: ws://${this.config.host}:${this.config.port}`);

          // 发送启动事件
          eventBus.emit(EventTypes.SYSTEM_START, {
            host: this.config.host,
            port: this.config.port,
          });

          resolve();
        });

        this.httpServer.on('error', (error) => {
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    // 关闭所有客户端连接
    for (const [clientId] of this.clients) {
      this.disconnectClient(clientId, 'Server shutdown');
    }

    // 关闭 WebSocket 服务器
    if (this.wsServer) {
      await new Promise<void>((resolve) => {
        this.wsServer!.close(() => {
          logger.info('WebSocket 服务器已关闭');
          resolve();
        });
      });
      this.wsServer = null;
    }

    // 关闭 HTTP 服务器
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          logger.info('HTTP 服务器已关闭');
          resolve();
        });
      });
      this.httpServer = null;
    }

    this.startedAt = null;
    logger.info('Gateway 已停止');
  }

  /**
   * 注册方法
   */
  registerMethod(definition: MethodDefinition): void {
    this.methods.set(definition.name, definition);
    logger.debug(`已注册方法: ${definition.name}`);
  }

  /**
   * 获取状态
   */
  getStatus(): GatewayStatus {
    return {
      running: this.httpServer !== null,
      startedAt: this.startedAt || undefined,
      connections: this.clients.size,
      activeSessions: 0, // TODO: 从会话管理器获取
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : undefined,
      version: '3.1.0',
    };
  }

  /**
   * 广播事件给所有客户端
   */
  broadcast(event: GatewayEvent): void {
    const message: GatewayMessage = {
      type: 'event',
      payload: event,
    };

    const data = JSON.stringify(message);

    for (const ws of this.clientSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * 发送事件给特定客户端
   */
  sendToClient(clientId: string, event: GatewayEvent): void {
    const ws = this.clientSockets.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message: GatewayMessage = {
        type: 'event',
        payload: event,
      };
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * 处理新连接
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const clientId = this.generateClientId();
    const remoteAddress = req.socket.remoteAddress;

    // 创建客户端信息
    const client: ClientConnection = {
      id: clientId,
      type: 'cli', // 默认类型，可以通过认证升级
      connectedAt: new Date(),
      lastActiveAt: new Date(),
      remoteAddress,
    };

    this.clients.set(clientId, client);
    this.clientSockets.set(clientId, ws);

    logger.info(`客户端连接: ${clientId} (${remoteAddress})`);

    // 设置消息处理器
    ws.on('message', (data: RawData) => {
      this.handleMessage(clientId, data);
    });

    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });

    ws.on('error', (error) => {
      logger.error(`客户端错误 [${clientId}]:`, error);
    });

    // 发送欢迎消息
    this.sendToClient(clientId, {
      type: 'gateway:connected',
      data: { clientId, version: '3.1.0' },
      timestamp: Date.now(),
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(clientId: string, data: RawData): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastActiveAt = new Date();

    try {
      const message: GatewayMessage = JSON.parse(data.toString());

      if (message.type === 'request' && message.payload) {
        const request = message.payload as GatewayRequest;
        const response = await this.handleRequest(request, client);

        const responseMessage: GatewayMessage = {
          type: 'response',
          payload: response,
        };

        const ws = this.clientSockets.get(clientId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(responseMessage));
        }
      } else if (message.type === 'ping') {
        // 心跳响应
        const ws = this.clientSockets.get(clientId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      }
    } catch (error) {
      logger.error(`处理消息错误 [${clientId}]:`, error);
    }
  }

  /**
   * 处理请求
   */
  private async handleRequest(
    request: GatewayRequest,
    client: ClientConnection
  ): Promise<GatewayResponse> {
    const method = this.methods.get(request.method);

    if (!method) {
      return {
        id: request.id,
        success: false,
        error: {
          code: ErrorCodes.METHOD_NOT_FOUND,
          message: `方法未找到: ${request.method}`,
        },
      };
    }

    // 检查认证（如果需要）
    if (method.requiresAuth && !client.auth) {
      return {
        id: request.id,
        success: false,
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message: '需要认证',
        },
      };
    }

    try {
      const result = await method.handler(request.params || {}, client);
      return {
        id: request.id,
        success: true,
        result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`方法执行错误 [${request.method}]:`, errorMessage);

      return {
        id: request.id,
        success: false,
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: errorMessage,
        },
      };
    }
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(clientId: string): void {
    this.clients.delete(clientId);
    this.clientSockets.delete(clientId);
    logger.info(`客户端断开: ${clientId}`);
  }

  /**
   * 断开客户端
   */
  private disconnectClient(clientId: string, reason: string): void {
    const ws = this.clientSockets.get(clientId);
    if (ws) {
      ws.close(1000, reason);
    }
    this.handleDisconnect(clientId);
  }

  /**
   * 处理 HTTP 请求（健康检查等）
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...this.getStatus() }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  /**
   * 注册内置方法
   */
  private registerBuiltinMethods(): void {
    // Ping
    this.registerMethod({
      name: BuiltinMethods.PING,
      description: '健康检查',
      handler: () => ({ pong: true, timestamp: Date.now() }),
    });

    // 状态
    this.registerMethod({
      name: BuiltinMethods.STATUS,
      description: '获取 Gateway 状态',
      handler: () => this.getStatus(),
    });

    // 会话列表
    this.registerMethod({
      name: BuiltinMethods.SESSION_LIST,
      description: '获取会话列表',
      handler: () => ({ sessions: [] }), // TODO: 实际实现
    });

    // 配置获取
    this.registerMethod({
      name: BuiltinMethods.CONFIG_GET,
      description: '获取配置',
      handler: () => ({ config: {} }), // TODO: 实际实现
    });

    // 插件列表
    this.registerMethod({
      name: BuiltinMethods.PLUGIN_LIST,
      description: '获取插件列表',
      handler: () => ({ plugins: [] }), // TODO: 实际实现
    });

    // 通道状态
    this.registerMethod({
      name: BuiltinMethods.CHANNEL_STATUS,
      description: '获取通道状态',
      handler: () => ({ channels: [] }), // TODO: 实际实现
    });
  }

  /**
   * 生成客户端 ID
   */
  private generateClientId(): string {
    return `client-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }
}

/**
 * 创建 Gateway 服务器
 */
export function createGatewayServer(config: Partial<GatewayConfig>): GatewayServer {
  return new GatewayServer(config);
}
