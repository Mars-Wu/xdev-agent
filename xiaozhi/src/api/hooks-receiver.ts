// src/api/hooks-receiver.ts
// HTTP API 服务器 - 专家管理、会话管理、回调处理、生命周期钩子

import express, { Request, Response, NextFunction } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { ClaudeNativeAgent } from '../core/claude-native-agent';
import { ExpertManager } from '../expert/manager';
import { createLogger } from '../utils/logger';
import {
  ExpertCompleteCallback,
  CreateExpertParams,
  ExpertCallParams,
} from '../expert/types';
import { CronManager } from '../cron/manager';
import { CreateCronTaskParams } from '../cron/types';

const logger = createLogger('hooks-receiver');

// ==================== OpenAPI 文档配置 ====================

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AI管家小智 API',
      version: '3.1.0',
      description: '基于 Claude CLI 的智能管家系统 API 文档',
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
        Expert: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            specialties: { type: 'array', items: { type: 'string' } },
            type: { type: 'string', enum: ['predefined', 'dynamic'] },
            stats: {
              type: 'object',
              properties: {
                totalCalls: { type: 'integer' },
                successCount: { type: 'integer' },
                lastUsedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        Session: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            expertName: { type: 'string' },
            status: { type: 'string', enum: ['running', 'completed', 'failed', 'terminated'] },
            task: { type: 'object' },
            execution: { type: 'object' },
            result: { type: 'object' },
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

// ==================== 生命周期钩子（P2）====================

/**
 * 钩子类型
 */
export type HookType =
  | 'session_start'    // 会话开始
  | 'user_prompt'      // 用户发送消息
  | 'post_tool'        // 工具调用后
  | 'session_end'      // 会话结束
  | 'expert_complete'; // 专家完成

/**
 * 钩子负载
 */
export interface HookPayload {
  type: HookType;
  sessionId?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * 钩子处理器
 */
export type HookHandler = (payload: HookPayload) => Promise<void> | void;

/**
 * 钩子配置
 */
export interface HookConfig {
  enabled: boolean;
  handlers: Record<HookType, HookHandler[]>;
}

export class HooksReceiver {
  private app: express.Application;
  private agent?: ClaudeNativeAgent;
  private expertManager?: ExpertManager;
  private cronManager?: CronManager;
  private server?: ReturnType<express.Application['listen']>;
  private apiToken: string | null = null;

  // P2: 生命周期钩子
  private hookConfig: HookConfig = {
    enabled: true,
    handlers: {
      session_start: [],
      user_prompt: [],
      post_tool: [],
      session_end: [],
      expert_complete: [],
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
   * 设置小智 Agent
   */
  setAgent(agent: ClaudeNativeAgent): void {
    this.agent = agent;
    logger.info('HooksReceiver 已关联 ClaudeNativeAgent');
  }

  /**
   * 设置专家管理器
   */
  setExpertManager(manager: ExpertManager): void {
    this.expertManager = manager;
    logger.info('HooksReceiver 已关联 ExpertManager');
  }

  /**
   * 设置 Cron 管理器
   */
  setCronManager(manager: CronManager): void {
    this.cronManager = manager;
    logger.info('HooksReceiver 已关联 CronManager');
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // ==================== API 文档 ====================
    this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
    this.app.get('/api-docs.json', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(swaggerSpec);
    });

    // ==================== 健康检查 ====================
    this.app.get('/health', this.handleHealthCheck.bind(this));
    this.app.get('/health/detailed', this.requireAuthToken.bind(this), this.handleDetailedHealthCheck.bind(this));

    // ==================== 专家管理 API ====================

    // 静态路由（必须在动态路由之前）
    this.app.get('/api/experts', this.handleListExperts.bind(this));
    this.app.post('/api/experts', this.requireAuthToken.bind(this), this.handleCreateExpert.bind(this));
    this.app.get('/api/experts/config', this.handleGetConfig.bind(this));
    this.app.put('/api/experts/config', this.requireAuthToken.bind(this), this.handleUpdateConfig.bind(this));
    this.app.get('/api/experts/queue', this.handleGetQueueStatus.bind(this));
    this.app.delete('/api/experts/queue', this.requireAuthToken.bind(this), this.handleClearQueue.bind(this));

    // 动态路由（:name）
    this.app.get('/api/experts/:name', this.handleGetExpert.bind(this));
    this.app.delete('/api/experts/:name', this.requireAuthToken.bind(this), this.handleDeleteExpert.bind(this));
    this.app.post('/api/experts/:name/call', this.requireAuthToken.bind(this), this.handleCallExpert.bind(this));
    this.app.get('/api/experts/:name/sessions', this.handleGetExpertSessions.bind(this));

    // ==================== 会话管理 API ====================
    this.app.get('/api/sessions/:id', this.handleGetSession.bind(this));
    this.app.post('/api/sessions/:id/stop', this.requireAuthToken.bind(this), this.handleStopSession.bind(this));

    // ==================== 回调 API ====================
    this.app.post('/api/callbacks/complete', this.handleExpertCompleteCallback.bind(this));

    // ==================== 生命周期钩子 API（P2）====================
    this.app.post('/api/hooks/trigger', this.requireAuthToken.bind(this), this.handleTriggerHook.bind(this));
    this.app.get('/api/hooks', this.handleListHooks.bind(this));
    this.app.post('/api/hooks/:type/register', this.requireAuthToken.bind(this), this.handleRegisterHook.bind(this));

    // ==================== Cron 定时任务 API ====================
    this.app.get('/api/cron/tasks', this.handleListCronTasks.bind(this));
    this.app.post('/api/cron/tasks', this.requireAuthToken.bind(this), this.handleCreateCronTask.bind(this));
    this.app.get('/api/cron/tasks/:id', this.handleGetCronTask.bind(this));
    this.app.delete('/api/cron/tasks/:id', this.requireAuthToken.bind(this), this.handleDeleteCronTask.bind(this));
    this.app.post('/api/cron/tasks/:id/enable', this.requireAuthToken.bind(this), this.handleEnableCronTask.bind(this));
    this.app.post('/api/cron/tasks/:id/disable', this.requireAuthToken.bind(this), this.handleDisableCronTask.bind(this));
    this.app.post('/api/cron/tasks/:id/trigger', this.requireAuthToken.bind(this), this.handleTriggerCronTask.bind(this));
    this.app.get('/api/cron/status', this.handleGetCronStatus.bind(this));

    // ==================== 测试 API ====================
    this.app.post('/test/message', this.requireAuthToken.bind(this), this.handleTestMessage.bind(this));
  }

  // ==================== API 实现 ====================

  /**
   * GET /health - 简单健康检查
   */
  private handleHealthCheck(req: Request, res: Response): void {
    const checks = {
      server: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    };

    // 快速检查关键组件
    if (!this.agent || !this.expertManager) {
      res.status(503).json({
        ...checks,
        status: 'degraded',
        message: '部分组件未初始化',
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
  private handleDetailedHealthCheck(req: Request, res: Response): void {
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

    // Agent 状态
    if (this.agent) {
      const queueStatus = this.agent.getQueueStatus();
      checks.agent = {
        status: 'ok',
        details: {
          queueLength: queueStatus.length,
          queueUtilization: queueStatus.utilizationPercent,
          isProcessing: queueStatus.isProcessing,
          dropCount: this.agent.getQueueDropCount(),
        },
      };
    } else {
      checks.agent = { status: 'unavailable' };
    }

    // 专家系统状态
    if (this.expertManager) {
      const queueStatus = this.expertManager.getQueueStatus();
      const experts = this.expertManager.getExperts();
      checks.experts = {
        status: 'ok',
        details: {
          totalExperts: experts.length,
          runningTasks: queueStatus.runningCount,
          queuedTasks: queueStatus.queueLength,
        },
      };
    } else {
      checks.experts = { status: 'unavailable' };
    }

    // Claude CLI 状态（异步检测，使用缓存）
    checks.claude_cli = this.checkClaudeCLI();

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

    // 如果状态不是 ok，返回 503
    if (overallStatus === 'critical' || overallStatus === 'degraded') {
      res.status(503).json(response);
    } else {
      res.json(response);
    }
  }

  /**
   * @openapi
   * /api/experts:
   *   get:
   *     summary: 获取专家列表
   *     description: 返回所有可用专家的配置信息
   *     tags:
   *       - 专家管理
   *     responses:
   *       200:
   *         description: 成功获取专家列表
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 experts:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Expert'
   *       503:
   *         description: 服务不可用
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  private handleListExperts(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }
    const experts = this.expertManager.getExperts();
    res.json({ experts });
  }

  /**
   * GET /api/experts/:name - 获取专家详情
   */
  private handleGetExpert(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const { name } = req.params;
    const expert = this.expertManager.getExpert(name);
    const status = this.expertManager.getExpertStatus(name);

    if (!expert) {
      res.status(404).json({ error: `专家 ${name} 不存在` });
      return;
    }

    res.json({ expert, status });
  }

  /**
   * POST /api/experts - 创建专家
   */
  private async handleCreateExpert(req: Request, res: Response): Promise<void> {
    const { name, description, specialties, customPrompt, type } = req.body;

    if (!name || !description || !specialties) {
      res.status(400).json({ error: 'Missing required fields: name, description, specialties' });
      return;
    }

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      const params: CreateExpertParams = { name, description, specialties, customPrompt, type };
      const config = await this.expertManager.createExpert(params);
      res.status(201).json({ status: 'ok', expert: config });
    } catch (error) {
      logger.error('[Expert] 创建失败:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message.includes('已存在') ? message : '专家创建失败' });
    }
  }

  /**
   * DELETE /api/experts/:name - 删除专家
   */
  private async handleDeleteExpert(req: Request, res: Response): Promise<void> {
    const { name } = req.params;

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      const deleted = await this.expertManager.deleteExpert(name);
      if (deleted) {
        res.json({ status: 'ok', message: `专家 ${name} 已删除` });
      } else {
        res.status(404).json({ error: `专家 ${name} 不存在` });
      }
    } catch (error) {
      logger.error('[Expert] 删除失败:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message.includes('运行中') ? message : '专家删除失败' });
    }
  }

  /**
   * POST /api/experts/:name/call - 调用专家
   *
   * 会话策略：
   * - continue: true  -> 使用 --continue，继续该工作目录的最近会话
   * - continue: false -> 新会话（默认）
   */
  private async handleCallExpert(req: Request, res: Response): Promise<void> {
    const { name } = req.params;
    const { task, workDir, model, category, tags, continue: shouldContinue } = req.body;

    if (!task) {
      res.status(400).json({ error: 'Missing task' });
      return;
    }

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      const params: ExpertCallParams = {
        expertName: name,
        task,
        workDir,
        model,
        category,
        tags,
        shouldContinue: shouldContinue === true,
      };

      const result = await this.expertManager.callExpert(params);
      res.json({ status: 'ok', expert: name, sessionId: result.sessionId, message: '专家已启动' });
    } catch (error) {
      logger.error('[Expert] 调用失败:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message.includes('不存在') ? message : '专家调用失败' });
    }
  }

  /**
   * GET /api/sessions/:id - 获取会话状态
   */
  private handleGetSession(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const { id } = req.params;
    const session = this.expertManager.getSession(id);

    if (!session) {
      res.status(404).json({ error: `会话 ${id} 不存在` });
      return;
    }

    res.json({ session });
  }

  /**
   * POST /api/sessions/:id/stop - 停止会话
   */
  private handleStopSession(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const { id } = req.params;
    const session = this.expertManager.getSession(id);

    if (!session) {
      res.status(404).json({ error: `会话 ${id} 不存在` });
      return;
    }

    this.expertManager.forceStopExpert(session.expertName, 'API 请求');
    res.json({ status: 'ok', message: `会话 ${id} 已停止` });
  }

  /**
   * GET /api/experts/:name/sessions - 获取专家的会话历史
   */
  private handleGetExpertSessions(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const { name } = req.params;
    const { limit } = req.query;

    const sessions = this.expertManager.getExpertSessions(name, limit ? parseInt(limit as string, 10) : 50);
    res.json({ expert: name, sessions });
  }

  /**
   * POST /api/callbacks/complete - 专家完成回调
   */
  private async handleExpertCompleteCallback(req: Request, res: Response): Promise<void> {
    const data: ExpertCompleteCallback = req.body;
    const { sessionId, expert, success, result } = data;

    logger.info(`[Callback] 专家 ${expert} 完成: sessionId=${sessionId}, success=${success}`);

    if (!expert) {
      res.status(400).json({ error: 'Missing expert name' });
      return;
    }

    try {
      // 更新专家管理器
      if (this.expertManager && sessionId) {
        this.expertManager.handleExpertComplete(sessionId, success !== false, result || '');
      }

      // 转发给小智处理
      if (this.agent) {
        const resultText = typeof result === 'string' ? result : JSON.stringify(result || '');
        await this.agent.handleExpertMessage({
          expertName: expert,
          success: success !== false,
          result: resultText,
          task: '',
        });
        logger.info(`[Callback] 结果已转发给小智`);
      }

      res.json({ status: 'ok', expert, sessionId });
    } catch (error) {
      logger.error('[Callback] 处理失败:', error);
      res.status(500).json({ error: 'Internal error' });
    }
  }

  /**
   * GET /api/experts/config - 获取配置
   */
  private handleGetConfig(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }
    res.json(this.expertManager.getConfig());
  }

  /**
   * PUT /api/experts/config - 更新配置
   */
  private handleUpdateConfig(req: Request, res: Response): void {
    const { maxConcurrent, defaultTimeout, preventRecursion } = req.body;

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (maxConcurrent !== undefined) updates.maxConcurrent = maxConcurrent;
    if (defaultTimeout !== undefined) updates.defaultTimeout = defaultTimeout;
    if (preventRecursion !== undefined) updates.preventRecursion = preventRecursion;

    this.expertManager.updateConfig(updates);
    res.json({ status: 'ok', config: this.expertManager.getConfig() });
  }

  /**
   * GET /api/experts/queue - 获取队列状态
   */
  private handleGetQueueStatus(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }
    res.json(this.expertManager.getQueueStatus());
  }

  /**
   * DELETE /api/experts/queue - 清空队列
   */
  private handleClearQueue(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }
    const count = this.expertManager.clearQueue();
    res.json({ status: 'ok', cleared: count });
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

    if (!this.agent) {
      res.status(503).json({ error: 'Agent not initialized' });
      return;
    }

    try {
      const response = await this.agent.processTestMessage(content);
      res.json({ status: 'ok', response });
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

  // ==================== Claude CLI 健康检查 ====================

  private claudeCLICache: { status: string; version?: string; timestamp: number } | null = null;
  private readonly CLI_CACHE_TTL = 60000; // 1 分钟缓存

  /**
   * 检查 Claude CLI 可用性
   */
  private checkClaudeCLI(): { status: string; details?: Record<string, unknown> } {
    // 使用缓存
    if (this.claudeCLICache && Date.now() - this.claudeCLICache.timestamp < this.CLI_CACHE_TTL) {
      return {
        status: this.claudeCLICache.status,
        details: { version: this.claudeCLICache.version, cached: true },
      };
    }

    try {
      const { execSync } = require('child_process');
      const version = execSync('claude --version 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      this.claudeCLICache = {
        status: 'ok',
        version: version || 'unknown',
        timestamp: Date.now(),
      };

      return {
        status: 'ok',
        details: { version: this.claudeCLICache.version },
      };
    } catch (error) {
      this.claudeCLICache = {
        status: 'unavailable',
        timestamp: Date.now(),
      };

      return {
        status: 'unavailable',
        details: { error: 'Claude CLI not found or not accessible' },
      };
    }
  }

  close(): void {
    if (this.server) {
      this.server.close();
      logger.info('HTTP receiver closed');
    }
  }

  // ==================== 生命周期钩子 API（P2）====================

  /**
   * POST /api/hooks/trigger - 触发钩子
   */
  private async handleTriggerHook(req: Request, res: Response): Promise<void> {
    const { type, sessionId, data } = req.body;

    if (!type) {
      res.status(400).json({ error: 'Missing hook type' });
      return;
    }

    const validTypes: HookType[] = ['session_start', 'user_prompt', 'post_tool', 'session_end', 'expert_complete'];
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
  private handleListHooks(req: Request, res: Response): void {
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

    const validTypes: HookType[] = ['session_start', 'user_prompt', 'post_tool', 'session_end', 'expert_complete'];
    if (!validTypes.includes(type as HookType)) {
      res.status(400).json({ error: `Invalid hook type: ${type}` });
      return;
    }

    // 注册 URL 处理器
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

    // 并行执行所有处理器
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

  // ==================== Cron 定时任务 API 实现 ====================

  /**
   * GET /api/cron/tasks - 列出所有 Cron 任务
   */
  private handleListCronTasks(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { chatId } = req.query;
    const tasks = chatId
      ? this.cronManager.getTasksByChatId(chatId as string)
      : this.cronManager.getAllTasks();

    res.json({ tasks, count: tasks.length });
  }

  /**
   * POST /api/cron/tasks - 创建 Cron 任务
   */
  private handleCreateCronTask(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { description, cronExpr, taskContent, chatId, silent } = req.body;

    if (!description || !cronExpr || !taskContent || !chatId) {
      res.status(400).json({
        error: 'Missing required fields: description, cronExpr, taskContent, chatId'
      });
      return;
    }

    try {
      const params: CreateCronTaskParams = {
        description,
        cronExpr,
        taskContent,
        chatId,
        silent: silent === true,
      };

      const task = this.cronManager.createTask(params);
      res.status(201).json({ status: 'ok', task });
    } catch (error) {
      logger.error('[Cron] 创建任务失败:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ error: message });
    }
  }

  /**
   * GET /api/cron/tasks/:id - 获取单个任务
   */
  private handleGetCronTask(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { id } = req.params;
    const task = this.cronManager.getTask(id);

    if (!task) {
      res.status(404).json({ error: `任务 ${id} 不存在` });
      return;
    }

    res.json({ task });
  }

  /**
   * DELETE /api/cron/tasks/:id - 删除任务
   */
  private handleDeleteCronTask(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { id } = req.params;
    const deleted = this.cronManager.deleteTask(id);

    if (!deleted) {
      res.status(404).json({ error: `任务 ${id} 不存在` });
      return;
    }

    res.json({ status: 'ok', message: `任务 ${id} 已删除` });
  }

  /**
   * POST /api/cron/tasks/:id/enable - 启用任务
   */
  private handleEnableCronTask(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { id } = req.params;
    const enabled = this.cronManager.enableTask(id);

    if (!enabled) {
      res.status(404).json({ error: `任务 ${id} 不存在` });
      return;
    }

    res.json({ status: 'ok', message: `任务 ${id} 已启用` });
  }

  /**
   * POST /api/cron/tasks/:id/disable - 禁用任务
   */
  private handleDisableCronTask(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { id } = req.params;
    const disabled = this.cronManager.disableTask(id);

    if (!disabled) {
      res.status(404).json({ error: `任务 ${id} 不存在` });
      return;
    }

    res.json({ status: 'ok', message: `任务 ${id} 已禁用` });
  }

  /**
   * POST /api/cron/tasks/:id/trigger - 手动触发任务
   */
  private async handleTriggerCronTask(req: Request, res: Response): Promise<void> {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const { id } = req.params;

    try {
      const triggered = await this.cronManager.triggerTask(id);

      if (!triggered) {
        res.status(404).json({ error: `任务 ${id} 不存在` });
        return;
      }

      res.json({ status: 'ok', message: `任务 ${id} 已触发` });
    } catch (error) {
      logger.error('[Cron] 触发任务失败:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * GET /api/cron/status - 获取 Cron 系统状态
   */
  private handleGetCronStatus(req: Request, res: Response): void {
    if (!this.cronManager) {
      res.status(503).json({ error: 'CronManager not initialized' });
      return;
    }

    const status = this.cronManager.getStatus();
    res.json(status);
  }
}
