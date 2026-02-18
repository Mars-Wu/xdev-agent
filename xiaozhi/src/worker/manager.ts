// src/worker/manager.ts
// Worker管理器

import * as path from 'path';
import * as fs from 'fs/promises';
import { TmuxClient } from '../utils/tmux';
import { SQLiteStorage } from '../storage/sqlite';
import { WorkerFactory } from './factory';
import {
  ClaudeWorker,
  WorkerSpawnConfig,
  WorkerManagerConfig,
  WorkerStatus,
} from './types';
import { createLogger } from '../utils/logger';

const logger = createLogger('worker-manager');

export class WorkerManager {
  private tmuxClient: TmuxClient;
  private factory: WorkerFactory;
  private storage: SQLiteStorage;
  private config: WorkerManagerConfig;

  constructor(storage: SQLiteStorage, config: WorkerManagerConfig) {
    this.storage = storage;
    this.config = config;
    this.tmuxClient = new TmuxClient();
    this.factory = new WorkerFactory(config);
  }

  /**
   * 创建并启动Worker
   */
  async spawnWorker(config: WorkerSpawnConfig): Promise<ClaudeWorker> {
    const workerId = this.factory.generateWorkerId();
    logger.info(`Creating worker ${workerId} for task: ${config.task.slice(0, 50)}...`);

    // 1. 创建Worker目录
    await this.factory.createWorkerDirectory(workerId);

    // 2. 写入Hooks配置
    await this.factory.writeHooksConfig(workerId);

    // 3. 写入任务描述
    await this.factory.writeTaskDescription(workerId, config.task);

    // 4. 创建tmux会话
    const tmuxSession = `worker_${workerId.slice(2, 10)}`;
    await this.tmuxClient.createSession({
      name: tmuxSession,
      cwd: config.workDir || path.join(this.config.baseDir, 'workers', workerId),
      detached: true,
    });

    // 5. 设置环境变量
    await this.tmuxClient.setEnvironment(tmuxSession, {
      XIAOZHI_WORKER_ID: workerId,
      XIAOZHI_SESSION_ID: config.sessionId,
      XIAOZHI_HOST: this.config.xiaozhiHost,
      XIAOZHI_PORT: String(this.config.xiaozhiPort),
    });

    // 6. 创建Worker元数据
    const worker = this.factory.createWorkerMetadata(workerId, config, tmuxSession);
    worker.status = 'running';
    worker.startedAt = new Date();

    // 7. 保存到数据库和文件
    this.saveWorkerToStorage(worker);
    await this.factory.saveWorkerMeta(worker);

    // 8. 构建并执行Claude命令
    const claudeCmd = this.factory.buildClaudeCommand(workerId, config);
    logger.info(`Starting claude command in tmux session ${tmuxSession}`);
    await this.tmuxClient.sendKeys(tmuxSession, claudeCmd);

    logger.info(`Worker ${workerId} started successfully`);
    return worker;
  }

  /**
   * 获取Worker状态
   */
  async getStatus(workerId: string): Promise<ClaudeWorker | null> {
    // 先从文件加载元数据
    let worker = await this.factory.loadWorkerMeta(workerId);

    // 如果文件不存在，从数据库加载
    if (!worker) {
      const record = this.storage.getWorker(workerId);
      if (record) {
        worker = this.recordToWorker(record);
      }
    }

    if (!worker) {
      return null;
    }

    // 检查tmux会话状态
    const tmuxAlive = await this.tmuxClient.sessionExists(worker.tmuxSession);
    if (!tmuxAlive && worker.status === 'running') {
      // tmux会话已结束但状态还是running，更新为completed
      worker.status = 'completed';
      worker.completedAt = new Date();
      await this.factory.saveWorkerMeta(worker);
    }

    // 读取进度文件
    try {
      const progressData = await fs.readFile(worker.hooks.progressFile, 'utf-8');
      const progress = JSON.parse(progressData);
      worker.progress = { ...worker.progress, ...progress };
    } catch {
      // 进度文件不存在，使用默认值
    }

    // 统计操作日志
    try {
      const workerDir = path.join(this.config.baseDir, 'workers', workerId);
      const logContent = await fs.readFile(
        path.join(workerDir, 'actions.log'),
        'utf-8'
      );
      const lines = logContent.trim().split('\n').filter(Boolean);
      worker.progress.toolCalls = lines.length;
    } catch {
      // 日志文件不存在
    }

    return worker;
  }

  /**
   * 列出会话的所有Worker
   */
  async listBySession(sessionId: string): Promise<ClaudeWorker[]> {
    const records = this.storage.getWorkersBySession(sessionId);
    const workers: ClaudeWorker[] = [];

    for (const record of records) {
      const worker = await this.getStatus(record.id);
      if (worker) {
        workers.push(worker);
      }
    }

    return workers;
  }

  /**
   * 终止Worker
   */
  async terminate(workerId: string, force: boolean = false): Promise<void> {
    const worker = await this.getStatus(workerId);
    if (!worker) {
      logger.warn(`Worker ${workerId} not found`);
      return;
    }

    logger.info(`Terminating worker ${workerId} (force: ${force})`);

    if (await this.tmuxClient.sessionExists(worker.tmuxSession)) {
      if (force) {
        await this.tmuxClient.killSession(worker.tmuxSession);
      } else {
        // 发送Ctrl+C信号
        await this.tmuxClient.sendRawKeys(worker.tmuxSession, 'C-c');
        // 等待3秒后检查是否退出
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (await this.tmuxClient.sessionExists(worker.tmuxSession)) {
          await this.tmuxClient.killSession(worker.tmuxSession);
        }
      }
    }

    // 更新状态
    worker.status = 'completed';
    worker.completedAt = new Date();
    await this.factory.saveWorkerMeta(worker);
    this.storage.updateWorkerStatus(
      workerId,
      'completed',
      undefined,
      new Date().toISOString()
    );

    logger.info(`Worker ${workerId} terminated`);
  }

  /**
   * 更新Worker状态（供Hooks接收器调用）
   */
  async updateStatus(
    workerId: string,
    updates: {
      status?: WorkerStatus;
      result?: { success: boolean; summary: string; cost: number; duration: number };
      completedAt?: Date;
    }
  ): Promise<void> {
    const worker = await this.factory.loadWorkerMeta(workerId);
    if (!worker) return;

    if (updates.status) {
      worker.status = updates.status;
    }
    if (updates.result) {
      worker.result = updates.result;
    }
    if (updates.completedAt) {
      worker.completedAt = updates.completedAt;
    }

    await this.factory.saveWorkerMeta(worker);
    this.storage.updateWorkerStatus(
      workerId,
      updates.status || worker.status,
      updates.result ? JSON.stringify(updates.result) : undefined,
      updates.completedAt?.toISOString()
    );
  }

  /**
   * 保存Worker到存储
   */
  private saveWorkerToStorage(worker: ClaudeWorker): void {
    this.storage.saveWorker({
      id: worker.id,
      name: worker.name,
      sessionId: worker.sessionId,
      status: worker.status,
      tmuxSession: worker.tmuxSession,
      claudeSessionId: worker.claudeSessionId,
      task: JSON.stringify(worker.task),
      progress: JSON.stringify(worker.progress),
      result: worker.result ? JSON.stringify(worker.result) : undefined,
      hooks: JSON.stringify(worker.hooks),
      startedAt: worker.startedAt?.toISOString() || null,
    });
  }

  /**
   * 数据库记录转Worker对象
   */
  private recordToWorker(record: {
    id: string;
    name: string;
    sessionId: string;
    status: string;
    tmuxSession: string;
    claudeSessionId: string;
    task: string;
    progress: string;
    result: string | null;
    hooks: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  }): ClaudeWorker {
    return {
      id: record.id,
      name: record.name,
      sessionId: record.sessionId,
      status: record.status as WorkerStatus,
      tmuxSession: record.tmuxSession,
      claudeSessionId: record.claudeSessionId,
      task: JSON.parse(record.task),
      progress: JSON.parse(record.progress),
      result: record.result ? JSON.parse(record.result) : undefined,
      hooks: JSON.parse(record.hooks),
      createdAt: new Date(record.createdAt),
      startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
      completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    };
  }
}
