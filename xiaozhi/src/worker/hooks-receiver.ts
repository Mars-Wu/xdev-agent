// src/worker/hooks-receiver.ts
// HTTP 接收器 - 接收专家完成回调

import express, { Request, Response, NextFunction } from 'express';
import { ClaudeNativeAgent } from '../core/claude-native-agent';
import { ExpertManager, ExpertMessage } from '../expert/manager';
import { createLogger } from '../utils/logger';

const logger = createLogger('hooks-receiver');

export class HooksReceiver {
  private app: express.Application;
  private agent?: ClaudeNativeAgent;
  private expertManager?: ExpertManager;
  private server?: ReturnType<express.Application['listen']>;
  private apiToken: string | null = null;

  constructor() {
    this.app = express();
    // 从环境变量读取 API Token
    this.apiToken = process.env.XIAOZHI_API_TOKEN || null;
    if (this.apiToken) {
      logger.info('API Token 认证已启用');
    }
    this.setupRoutes();
  }

  /**
   * 验证 API Token 的中间件
   * 用于保护升级相关的敏感 API
   */
  private requireAuthToken(req: Request, res: Response, next: NextFunction): void {
    // 如果没有配置 token，允许访问（向后兼容）
    if (!this.apiToken) {
      next();
      return;
    }

    const providedToken = req.headers['x-xiaozhi-token'] as string;

    if (!providedToken) {
      res.status(401).json({ error: 'Missing authentication token' });
      return;
    }

    // 使用常量时间比较防止时序攻击
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

  private setupRoutes(): void {
    this.app.use(express.json());

    // 健康检查
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // 队列状态（调试用）
    this.app.get('/queue', (req: Request, res: Response) => {
      if (!this.agent) {
        res.json({ error: 'Agent not set' });
        return;
      }
      res.json(this.agent.getQueueStatus());
    });

    // 专家调用（小智调用）
    this.app.post('/expert/call', this.handleExpertCall.bind(this));

    // 专家完成回调（专家完成后通知）
    this.app.post('/expert/complete', this.handleExpertComplete.bind(this));

    // 专家状态查询
    this.app.get('/expert/status', this.handleExpertStatus.bind(this));

    // 专家列表
    this.app.get('/expert/list', this.handleExpertList.bind(this));

    // P1: 动态创建专家
    this.app.post('/expert/create', this.handleExpertCreate.bind(this));

    // P1: 删除专家
    this.app.delete('/expert/:name', this.handleExpertDelete.bind(this));

    // P1: 专家间通信
    this.app.post('/expert/message', this.handleExpertMessage.bind(this));

    // P1: 获取专家消息
    this.app.get('/expert/:name/messages', this.handleGetExpertMessages.bind(this));

    // P1: 任务队列状态
    this.app.get('/expert/queue', this.handleExpertQueueStatus.bind(this));

    // P1: 清空任务队列
    this.app.delete('/expert/queue', this.handleClearQueue.bind(this));

    // P0: 强制停止专家
    this.app.post('/expert/:name/stop', this.handleExpertStop.bind(this));

    // P1: 获取/更新配置
    this.app.get('/expert/config', this.handleGetConfig.bind(this));
    this.app.put('/expert/config', this.handleUpdateConfig.bind(this));

    // 测试消息（给影子实例用）
    this.app.post('/test/message', this.handleTestMessage.bind(this));

    // 兼容旧的 Worker hooks
    this.app.post('/hooks/stop', this.handleLegacyWorkerStop.bind(this));
  }

  /**
   * 调用专家
   */
  private async handleExpertCall(req: Request, res: Response): Promise<void> {
    const { expert, task, workDir } = req.body;

    if (!expert || !task) {
      res.status(400).json({ error: 'Missing expert or task' });
      return;
    }

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      await this.expertManager.callExpert({
        expertName: expert,
        task,
        workDir,
      });

      res.json({ status: 'ok', expert, message: '专家已启动' });
    } catch (error) {
      logger.error('[Expert] 调用失败:', error);
      res.status(500).json({ error: String(error) });
    }
  }

  /**
   * 获取专家列表
   */
  private handleExpertList(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const experts = this.expertManager.getExperts();
    res.json({ experts });
  }

  /**
   * 处理专家完成回调
   */
  private async handleExpertComplete(req: Request, res: Response): Promise<void> {
    const { expert, success, result, task } = req.body;

    logger.info(`[Expert] ${expert} 完成: success=${success}`);

    if (!expert) {
      res.status(400).json({ error: 'Missing expert name' });
      return;
    }

    try {
      // 更新专家状态
      if (this.expertManager) {
        this.expertManager.handleExpertComplete(
          expert,
          success !== false,
          result || ''
        );
      }

      // 转发给小智处理
      if (this.agent) {
        const resultText = typeof result === 'string' ? result : JSON.stringify(result || '');
        const taskText = typeof task === 'string' ? task : '';

        await this.agent.handleExpertMessage({
          expertName: expert,
          success: success !== false,
          result: resultText,
          task: taskText,
        });

        logger.info(`[Expert] ${expert} 结果已转发给小智`);
      }

      res.json({ status: 'ok', expert });
    } catch (error) {
      logger.error('[Expert] 处理完成回调失败:', error);
      res.status(500).json({ error: 'Internal error' });
    }
  }

  /**
   * 查询专家状态
   */
  private handleExpertStatus(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const status = this.expertManager.getAllStatus();
    res.json({ experts: status });
  }

  /**
   * P1: 动态创建专家
   */
  private async handleExpertCreate(req: Request, res: Response): Promise<void> {
    const { name, description, specialties, customPrompt } = req.body;

    if (!name || !description || !specialties) {
      res.status(400).json({ error: 'Missing required fields: name, description, specialties' });
      return;
    }

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      const config = await this.expertManager.createExpert(
        name,
        description,
        specialties,
        customPrompt
      );
      res.json({ status: 'ok', expert: config });
    } catch (error) {
      logger.error('[Expert] 创建失败:', error);
      res.status(500).json({ error: String(error) });
    }
  }

  /**
   * P1: 删除专家
   */
  private async handleExpertDelete(req: Request, res: Response): Promise<void> {
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
      res.status(500).json({ error: String(error) });
    }
  }

  /**
   * P1: 专家间通信
   */
  private async handleExpertMessage(req: Request, res: Response): Promise<void> {
    const { from, to, content } = req.body;

    if (!from || !to || !content) {
      res.status(400).json({ error: 'Missing required fields: from, to, content' });
      return;
    }

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      await this.expertManager.sendMessage(from, to, content);
      res.json({ status: 'ok', message: '消息已发送' });
    } catch (error) {
      logger.error('[Expert] 消息发送失败:', error);
      res.status(500).json({ error: String(error) });
    }
  }

  /**
   * P1: 获取专家消息
   */
  private handleGetExpertMessages(req: Request, res: Response): void {
    const { name } = req.params;
    const { limit } = req.query;

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const messages = this.expertManager.getMessages(name, limit ? parseInt(limit as string, 10) : 10);
    res.json({ expert: name, messages });
  }

  /**
   * P1: 获取任务队列状态
   */
  private handleExpertQueueStatus(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const queueStatus = this.expertManager.getQueueStatus();
    res.json(queueStatus);
  }

  /**
   * P1: 清空任务队列
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
   * P0: 强制停止专家
   */
  private handleExpertStop(req: Request, res: Response): void {
    const { name } = req.params;
    const { reason } = req.body;

    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    try {
      this.expertManager.forceStopExpert(name, reason || 'API 请求');
      res.json({ status: 'ok', message: `专家 ${name} 已停止` });
    } catch (error) {
      logger.error('[Expert] 停止失败:', error);
      res.status(500).json({ error: String(error) });
    }
  }

  /**
   * P1: 获取配置
   */
  private handleGetConfig(req: Request, res: Response): void {
    if (!this.expertManager) {
      res.status(503).json({ error: 'ExpertManager not initialized' });
      return;
    }

    const config = this.expertManager.getConfig();
    res.json(config);
  }

  /**
   * P1: 更新配置
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
   * 兼容旧的 Worker stop hook
   */
  private async handleLegacyWorkerStop(req: Request, res: Response): Promise<void> {
    const workerId = req.body.worker_id || req.body.workerId;
    const result = req.body.result || req.body.summary || '';

    logger.info(`[Legacy] Worker ${workerId} 完成`);

    // 转换为专家消息格式
    if (this.agent) {
      await this.agent.handleExpertMessage({
        expertName: 'worker',
        success: true,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        task: workerId,
      });
    }

    res.send('OK');
  }

  /**
   * 测试消息（给影子实例用）
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
      // 模拟飞书消息处理
      const response = await this.agent.processTestMessage(content);
      res.json({ status: 'ok', response });
    } catch (error) {
      logger.error('[Test] 测试消息处理失败:', error);
      res.status(500).json({ error: String(error) });
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
}
