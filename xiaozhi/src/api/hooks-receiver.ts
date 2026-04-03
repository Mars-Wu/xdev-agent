// src/api/hooks-receiver.ts
// HTTP API 服务器 - 简化版（移除专家系统和定时任务）

import express, { Request, Response, NextFunction } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { createLogger } from '../utils/logger';
import { LLMClient } from '../core/llm-client';
import { MessageHistoryManager } from '../core/message-history';

const logger = createLogger('hooks-receiver');

// ==================== OpenAPI 文档配置 ====================

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AI管家小智 API',
      version: '4.0.0',
      description: '基于 GLM SDK 的智能管家系统 API 文档',
      contact: {
        name: '小智项目',
      },
    },
    servers: [
      {
        url: 'http://localhost:8081',
        description: '本地开发服务器',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-xiaozhi-token',
        },
      },
      schemas: {
        Message: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  },
  apis: ['./src/api/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// ==================== 生命周期钩子 ====================

export type HookType =
  | 'session_start'
  | 'user_prompt'
  | 'post_tool'
  | 'session_end';

export interface HookPayload {
  type: HookType;
  sessionId?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type HookHandler = (payload: HookPayload) => Promise<void> | void;

export interface HookConfig {
  enabled: boolean;
  handlers: Record<HookType, HookHandler[]>;
}

export class HooksReceiver {
  private app: express.Application;
  private llmClient?: LLMClient;
  private historyManager?: MessageHistoryManager;
  private server?: ReturnType<express.Application['listen']>;
  private apiToken: string | null = null;

  // 生命周期钩子
  private hookConfig: HookConfig = {
    enabled: true,
    handlers: {
      session_start: [],
      user_prompt: [],
      post_tool: [],
      session_end: [],
    },
  };

  constructor() {
    this.app = express();
    this.apiToken = process.env.XIAOZHI_API_TOKEN || null;
    if (this.apiToken) {
      logger.info('API Token 认证已启用');
    }
    this.setupRoutes();
  }

  /**
   * 验证 API Token 的中间件
   */
  private requireAuthToken(req: Request, res: Response, next: NextFunction): void {
    if (!this.apiToken) {
      next();
      return;
    }

    const providedToken = req.headers['x-xiaozhi-token'] as string;

    if (!providedToken) {
      res.status(401).json({ error: 'Missing authentication token' });
      return;
    }

    if (!this.constantTimeCompare(providedToken, this.apiToken)) {
      res.status(403).json({ error: 'Invalid authentication token' });
      return;
    }

    next();
  }

  /**
   * 常量时间字符串比较（防止时序攻击）
   */
  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * 设置 LLM 客户端
   */
  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
    logger.info('HooksReceiver 已关联 LLMClient');
  }

  /**
   * 设置历史管理器
   */
  setHistoryManager(manager: MessageHistoryManager): void {
    this.historyManager = manager;
    logger.info('HooksReceiver 已关联 MessageHistoryManager');
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // API 文档
    this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
    this.app.get('/api-docs.json', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(swaggerSpec);
    });

    // 健康检查
    this.app.get('/health', this.handleHealthCheck.bind(this));
    this.app.get('/health/detailed', this.requireAuthToken.bind(this), this.handleDetailedHealthCheck.bind(this));

    // 模型 API
    this.app.get('/api/models', this.handleListModels.bind(this));
    this.app.get('/api/models/:id', this.handleGetModel.bind(this));

    // 会话 API
    this.app.get('/api/sessions/stats', this.handleGetSessionStats.bind(this));
    this.app.post('/api/sessions/clear', this.requireAuthToken.bind(this), this.handleClearSession.bind(this));

    // 聊天 API
    this.app.post('/api/chat', this.requireAuthToken.bind(this), this.handleChat.bind(this));

    // 生命周期钩子 API
    this.app.post('/api/hooks/trigger', this.requireAuthToken.bind(this), this.handleTriggerHook.bind(this));
    this.app.get('/api/hooks', this.handleListHooks.bind(this));
    this.app.post('/api/hooks/:type/register', this.requireAuthToken.bind(this), this.handleRegisterHook.bind(this));

    // 测试 API
    this.app.post('/test/message', this.requireAuthToken.bind(this), this.handleTestMessage.bind(this));
  }

  // ==================== API 实现 ====================

  /**
   * GET /health - 简单健康检查
   */
  private handleHealthCheck(_req: Request, res: Response): void {
    const checks = {
      server: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    };

    if (!this.llmClient) {
      res.status(503).json({
        ...checks,
        status: 'degraded',
        message: 'LLM 客户端未初始化',
      });
      return;
    }

    res.json({
      ...checks,
      status: 'ok',
    });
  }

  /**
   * GET /health/detailed - 详细健康检查
   */
  private handleDetailedHealthCheck(_req: Request, res: Response): void {
    const memoryUsage = process.memoryUsage();
    const checks: Record<string, { status: string; details?: Record<string, unknown> }> = {};

    // 服务器状态
    checks.server = {
      status: 'ok',
      details: {
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
      },
    };

    // 内存状态
    const memoryUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const memoryTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    const memoryPercent = Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100);

    checks.memory = {
      status: memoryPercent > 90 ? 'critical' : memoryPercent > 80 ? 'warning' : 'ok',
      details: {
        heapUsedMB: memoryUsedMB,
        heapTotalMB: memoryTotalMB,
        usagePercent: memoryPercent,
        rssMB: Math.round(memoryUsage.rss / 1024 / 1024),
      },
    };

    // LLM 客户端状态
    checks.llm = {
      status: this.llmClient ? 'ok' : 'unavailable',
    };

    // 计算整体状态
    const statuses = Object.values(checks).map(c => c.status);
    const overallStatus = statuses.includes('critical')
      ? 'critical'
      : statuses.includes('warning')
        ? 'warning'
        : statuses.includes('unavailable')
          ? 'degraded'
          : 'ok';

    const response = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    };

    if (overallStatus === 'critical' || overallStatus === 'degraded') {
      res.status(503).json(response);
    } else {
      res.json(response);
    }
  }

  /**
   * GET /api/models - 获取可用模型列表
   */
  private handleListModels(_req: Request, res: Response): void {
    if (!this.llmClient) {
      res.status(503).json({ error: 'LLM 客户端未初始化' });
      return;
    }
    const models = this.llmClient.listModels();
    res.json({ models });
  }

  /**
   * GET /api/models/:id - 获取模型详情
   */
  private handleGetModel(req: Request, res: Response): void {
    if (!this.llmClient) {
      res.status(503).json({ error: 'LLM 客户端未初始化' });
      return;
    }
    const { id } = req.params;
    const capability = this.llmClient.getModelCapability(id);
    if (!capability) {
      res.status(404).json({ error: `模型 ${id} 不存在` });
      return;
    }
    res.json({ model: capability });
  }

  /**
   * GET /api/sessions/stats - 获取会话统计
   */
  private handleGetSessionStats(_req: Request, res: Response): void {
    if (!this.historyManager) {
      res.status(503).json({ error: '历史管理器未初始化' });
      return;
    }
    res.json({
      messageCount: this.historyManager.getMessageCount(),
      tokenCount: this.historyManager.getTokenCount(),
    });
  }

  /**
   * POST /api/sessions/clear - 清空会话
   */
  private handleClearSession(_req: Request, res: Response): void {
    if (!this.historyManager) {
      res.status(503).json({ error: '历史管理器未初始化' });
      return;
    }
    this.historyManager.clear();
    res.json({ status: 'ok', message: '会话已清空' });
  }

  /**
   * POST /api/chat - 发送消息
   */
  private async handleChat(req: Request, res: Response): Promise<void> {
    const { message, model } = req.body;

    if (!message) {
      res.status(400).json({ error: 'Missing message' });
      return;
    }

    if (!this.llmClient) {
      res.status(503).json({ error: 'LLM 客户端未初始化' });
      return;
    }

    try {
      const response = await this.llmClient.chatSync({
        model: model || 'glm-5',
        maxTokens: 16000,
        messages: [{ role: 'user', content: message }],
      });

      res.json({
        status: 'ok',
        content: response.content,
        thinking: response.thinking,
        usage: response.usage,
      });
    } catch (error) {
      logger.error('[Chat] 处理失败:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /**
   * POST /test/message - 测试消息
   */
  private async handleTestMessage(req: Request, res: Response): Promise<void> {
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Missing content' });
      return;
    }

    if (!this.llmClient) {
      res.status(503).json({ error: 'LLM 客户端未初始化' });
      return;
    }

    try {
      const response = await this.llmClient.chatSync({
        model: 'glm-5',
        maxTokens: 1000,
        messages: [{ role: 'user', content }],
      });
      res.json({ status: 'ok', response: response.content });
    } catch (error) {
      logger.error('[Test] 测试消息处理失败:', error);
      res.status(500).json({ error: '测试消息处理失败' });
    }
  }

  listen(port: number): void {
    this.server = this.app.listen(port, () => {
      logger.info(`HTTP receiver listening on port ${port}`);
    });
  }

  close(): void {
    if (this.server) {
      this.server.close();
      logger.info('HTTP receiver closed');
    }
  }

  // ==================== 生命周期钩子 API ====================

  /**
   * POST /api/hooks/trigger - 触发钩子
   */
  private async handleTriggerHook(req: Request, res: Response): Promise<void> {
    const { type, sessionId, data } = req.body;

    if (!type) {
      res.status(400).json({ error: 'Missing hook type' });
      return;
    }

    const validTypes: HookType[] = ['session_start', 'user_prompt', 'post_tool', 'session_end'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: `Invalid hook type: ${type}` });
      return;
    }

    try {
      await this.triggerHook(type as HookType, sessionId, data);
      res.json({ status: 'ok', type, triggered: true });
    } catch (error) {
      logger.error('[Hook] 触发失败:', error);
      res.status(500).json({ error: 'Hook trigger failed' });
    }
  }

  /**
   * GET /api/hooks - 列出钩子配置
   */
  private handleListHooks(_req: Request, res: Response): void {
    const hooks: Record<string, { enabled: boolean; handlerCount: number }> = {};

    for (const [type, handlers] of Object.entries(this.hookConfig.handlers)) {
      hooks[type] = {
        enabled: this.hookConfig.enabled,
        handlerCount: handlers.length,
      };
    }

    res.json({ enabled: this.hookConfig.enabled, hooks });
  }

  /**
   * POST /api/hooks/:type/register - 注册钩子处理器
   */
  private handleRegisterHook(req: Request, res: Response): void {
    const { type } = req.params;
    const { handlerUrl } = req.body;

    if (!handlerUrl) {
      res.status(400).json({ error: 'Missing handlerUrl' });
      return;
    }

    const validTypes: HookType[] = ['session_start', 'user_prompt', 'post_tool', 'session_end'];
    if (!validTypes.includes(type as HookType)) {
      res.status(400).json({ error: `Invalid hook type: ${type}` });
      return;
    }

    const handler: HookHandler = async (payload) => {
      try {
        await fetch(handlerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        logger.error(`[Hook] 调用处理器失败 (${handlerUrl}):`, error);
      }
    };

    this.hookConfig.handlers[type as HookType].push(handler);
    logger.info(`[Hook] 注册处理器: ${type} -> ${handlerUrl}`);

    res.json({ status: 'ok', type, handlerUrl });
  }

  /**
   * 触发钩子
   */
  async triggerHook(type: HookType, sessionId?: string, data?: Record<string, unknown>): Promise<void> {
    if (!this.hookConfig.enabled) {
      return;
    }

    const payload: HookPayload = {
      type,
      sessionId,
      timestamp: new Date().toISOString(),
      data,
    };

    const handlers = this.hookConfig.handlers[type];
    if (handlers.length === 0) {
      return;
    }

    logger.debug(`[Hook] 触发: ${type} (${handlers.length} 个处理器)`);

    await Promise.allSettled(
      handlers.map(async (handler) => {
        try {
          await handler(payload);
        } catch (error) {
          logger.error(`[Hook] 处理器执行失败:`, error);
        }
      })
    );
  }

  /**
   * 启用/禁用钩子
   */
  setHooksEnabled(enabled: boolean): void {
    this.hookConfig.enabled = enabled;
    logger.info(`[Hook] ${enabled ? '启用' : '禁用'}钩子系统`);
  }
}
