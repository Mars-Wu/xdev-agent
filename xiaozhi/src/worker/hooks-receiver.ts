// src/worker/hooks-receiver.ts
// Hooks接收器 - 接收Worker的通知

import express, { Request, Response } from 'express';
import { WorkerManager } from './manager';
import { FeishuClient } from '../feishu/client';
import { SessionManager } from '../session/manager';
import { createLogger } from '../utils/logger';

const logger = createLogger('hooks-receiver');

export class HooksReceiver {
  private app: express.Application;
  private workerManager: WorkerManager;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager;
  private notificationThrottle: Map<string, number> = new Map();
  private server?: ReturnType<express.Application['listen']>;

  constructor(
    workerManager: WorkerManager,
    feishuClient: FeishuClient,
    sessionManager: SessionManager
  ) {
    this.workerManager = workerManager;
    this.feishuClient = feishuClient;
    this.sessionManager = sessionManager;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // 健康检查
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // 接收Notification Hook
    this.app.post('/internal/worker/notify', this.handleNotification.bind(this));

    // 接收Stop Hook
    this.app.post('/internal/worker/complete', this.handleComplete.bind(this));

    // 接收SubagentStop Hook
    this.app.post('/internal/worker/subagent', this.handleSubagent.bind(this));
  }

  private async handleNotification(req: Request, res: Response): Promise<void> {
    const { worker_id, type, message, timestamp } = req.body;

    logger.info(`Received notification from worker ${worker_id}: ${message?.slice(0, 50)}...`);

    try {
      const worker = await this.workerManager.getStatus(worker_id);
      if (!worker) {
        res.status(404).send('Worker not found');
        return;
      }

      // 更新进度
      worker.progress.currentStep = message || '处理中';
      worker.progress.lastUpdate = new Date(timestamp);

      // 检查是否应该节流通知
      if (this.shouldThrottleNotification(worker_id)) {
        res.send('OK (throttled)');
        return;
      }

      // 获取会话设置
      const session = await this.sessionManager.get(worker.sessionId);
      if (!session?.settings.notifyOnProgress) {
        res.send('OK (notification disabled)');
        return;
      }

      // 发送飞书通知
      await this.feishuClient.sendCard(session.feishuChatId, {
        header: {
          title: { content: `📊 ${worker.name} 进度更新`, tag: 'plain_text' },
          template: 'blue',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**当前步骤**: ${message}\n**状态**: 运行中\n**已运行**: ${this.formatDuration(worker.startedAt!)}`,
          },
        ],
      });

      this.notificationThrottle.set(worker_id, Date.now());
      res.send('OK');
    } catch (error) {
      logger.error('Handle notification error:', error);
      res.status(500).send('Internal error');
    }
  }

  private async handleComplete(req: Request, res: Response): Promise<void> {
    const { worker_id, status, result, cost, duration } = req.body;

    logger.info(`Received completion from worker ${worker_id}, status: ${status}`);

    try {
      const worker = await this.workerManager.getStatus(worker_id);
      if (!worker) {
        res.status(404).send('Worker not found');
        return;
      }

      // 更新Worker状态
      await this.workerManager.updateStatus(worker_id, {
        status: status === 'success' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          success: status === 'success',
          summary: result || '任务完成',
          cost: cost || 0,
          duration: duration || 0,
        },
      });

      // 从会话的活跃Worker列表中移除
      await this.sessionManager.removeWorker(worker.sessionId, worker_id);

      // 获取会话并发送完成通知
      const session = await this.sessionManager.get(worker.sessionId);
      if (session) {
        const emoji = status === 'success' ? '✅' : '❌';
        await this.feishuClient.sendCard(session.feishuChatId, {
          header: {
            title: { content: `${emoji} ${worker.name} 任务完成`, tag: 'plain_text' },
            template: status === 'success' ? 'green' : 'red',
          },
          elements: [
            {
              tag: 'markdown',
              content: `**状态**: ${status === 'success' ? '成功' : '失败'}\n**耗时**: ${this.formatDuration(worker.startedAt!, new Date())}\n**结果**:\n${result || '无详细结果'}`,
            },
          ],
        });
      }

      res.send('OK');
    } catch (error) {
      logger.error('Handle complete error:', error);
      res.status(500).send('Internal error');
    }
  }

  private async handleSubagent(req: Request, res: Response): Promise<void> {
    const { worker_id, subagent_id, subagent_type, result } = req.body;

    logger.info(`Received subagent notification: ${subagent_type} for worker ${worker_id}`);

    // 子代理完成，可选通知（这里只记录日志）
    logger.debug(`Subagent ${subagent_type} (${subagent_id}) completed for worker ${worker_id}`);

    res.send('OK');
  }

  private shouldThrottleNotification(workerId: string): boolean {
    const lastTime = this.notificationThrottle.get(workerId) || 0;
    const throttleInterval = 30000; // 30秒
    return Date.now() - lastTime < throttleInterval;
  }

  private formatDuration(start: Date, end: Date = new Date()): string {
    const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分钟`;
  }

  listen(port: number): void {
    this.server = this.app.listen(port, () => {
      logger.info(`Hooks receiver listening on port ${port}`);
    });
  }

  close(): void {
    if (this.server) {
      this.server.close();
      logger.info('Hooks receiver closed');
    }
  }
}
