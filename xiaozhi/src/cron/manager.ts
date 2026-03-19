// src/cron/manager.ts
// Cron 定时任务管理器
// 支持任务的创建、调度、持久化和回调触发

import * as cron from 'node-cron';

// 定义 ScheduleOptions 接口（因为 node-cron 的类型导出可能有问题）
interface CronScheduleOptions {
  scheduled?: boolean;
  timezone?: string;
  recoverMissedExecutions?: boolean;
  name?: string;
  runOnInit?: boolean;
}
import * as crypto from 'crypto';
import { SQLiteStorage } from '../storage/sqlite';
import {
  CronTask,
  CreateCronTaskParams,
  CronTaskRecord,
  CronTriggerCallback,
  CronManagerConfig,
} from './types';
import { createLogger } from '../utils/logger';

const logger = createLogger('cron-manager');

/**
 * Cron 定时任务管理器
 */
export class CronManager {
  private storage: SQLiteStorage;
  private config: CronManagerConfig;
  private scheduledJobs: Map<string, cron.ScheduledTask> = new Map();
  private isRunning: boolean = false;

  constructor(storage: SQLiteStorage, config: Partial<CronManagerConfig> = {}) {
    this.storage = storage;
    this.config = {
      callbackUrl: config.callbackUrl || 'http://localhost:8081/api/callbacks/complete',
      maxTasks: config.maxTasks || 100,
      enablePersistence: config.enablePersistence !== false,
    };
  }

  /**
   * 初始化管理器，恢复所有已启用的任务
   */
  async initialize(): Promise<void> {
    logger.info('初始化 CronManager...');

    // 确保数据库表存在
    this.storage.initCronTable();

    // 恢复所有已启用的任务
    const tasks = this.getAllTasks();
    for (const task of tasks) {
      if (task.enabled) {
        this.scheduleTask(task);
      }
    }

    this.isRunning = true;
    logger.info(`CronManager 已初始化，已恢复 ${tasks.filter(t => t.enabled).length} 个任务`);
  }

  /**
   * 创建新任务
   */
  createTask(params: CreateCronTaskParams): CronTask {
    // 验证 cron 表达式
    if (!cron.validate(params.cronExpr)) {
      throw new Error(`无效的 cron 表达式: ${params.cronExpr}`);
    }

    // 检查任务数量限制
    const currentTasks = this.getAllTasks();
    if (currentTasks.length >= this.config.maxTasks) {
      throw new Error(`已达到最大任务数限制 (${this.config.maxTasks})`);
    }

    const task: CronTask = {
      id: this.generateTaskId(),
      description: params.description,
      cronExpr: params.cronExpr,
      taskContent: params.taskContent,
      chatId: params.chatId,
      enabled: true,
      silent: params.silent || false,
      createdAt: new Date(),
      runCount: 0,
    };

    // 持久化
    this.storage.saveCronTask(this.taskToRecord(task));

    // 调度任务
    this.scheduleTask(task);

    logger.info(`创建 Cron 任务: ${task.id} - ${task.description}`);
    return task;
  }

  /**
   * 获取任务
   */
  getTask(id: string): CronTask | undefined {
    const record = this.storage.getCronTask(id);
    return record ? this.recordToTask(record) : undefined;
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): CronTask[] {
    const records = this.storage.getAllCronTasks();
    return records.map(r => this.recordToTask(r));
  }

  /**
   * 获取指定聊天的任务
   */
  getTasksByChatId(chatId: string): CronTask[] {
    const records = this.storage.getCronTasksByChatId(chatId);
    return records.map(r => this.recordToTask(r));
  }

  /**
   * 更新任务
   */
  updateTask(id: string, updates: Partial<Pick<CronTask, 'description' | 'cronExpr' | 'taskContent' | 'silent'>>): CronTask | undefined {
    const task = this.getTask(id);
    if (!task) {
      return undefined;
    }

    // 如果更新了 cron 表达式，需要验证
    if (updates.cronExpr && !cron.validate(updates.cronExpr)) {
      throw new Error(`无效的 cron 表达式: ${updates.cronExpr}`);
    }

    const updatedTask: CronTask = {
      ...task,
      ...updates,
    };

    // 如果任务已启用且 cron 表达式变更，需要重新调度
    if (task.enabled && updates.cronExpr) {
      this.unscheduleTask(id);
      this.scheduleTask(updatedTask);
    }

    // 持久化
    this.storage.saveCronTask(this.taskToRecord(updatedTask));

    logger.info(`更新 Cron 任务: ${id}`);
    return updatedTask;
  }

  /**
   * 启用任务
   */
  enableTask(id: string): boolean {
    const task = this.getTask(id);
    if (!task) {
      return false;
    }

    if (task.enabled) {
      return true; // 已经启用
    }

    task.enabled = true;
    this.storage.saveCronTask(this.taskToRecord(task));
    this.scheduleTask(task);

    logger.info(`启用 Cron 任务: ${id}`);
    return true;
  }

  /**
   * 禁用任务
   */
  disableTask(id: string): boolean {
    const task = this.getTask(id);
    if (!task) {
      return false;
    }

    if (!task.enabled) {
      return true; // 已经禁用
    }

    task.enabled = false;
    this.storage.saveCronTask(this.taskToRecord(task));
    this.unscheduleTask(id);

    logger.info(`禁用 Cron 任务: ${id}`);
    return true;
  }

  /**
   * 删除任务
   */
  deleteTask(id: string): boolean {
    const task = this.getTask(id);
    if (!task) {
      return false;
    }

    // 取消调度
    this.unscheduleTask(id);

    // 从数据库删除
    const deleted = this.storage.deleteCronTask(id);

    if (deleted) {
      logger.info(`删除 Cron 任务: ${id}`);
    }
    return deleted;
  }

  /**
   * 手动触发任务
   */
  async triggerTask(id: string): Promise<boolean> {
    const task = this.getTask(id);
    if (!task) {
      logger.warn(`尝试触发不存在的任务: ${id}`);
      return false;
    }

    logger.info(`手动触发任务: ${id} - ${task.description}`);
    await this.executeTask(task);
    return true;
  }

  /**
   * 调度任务
   */
  private scheduleTask(task: CronTask): void {
    // 如果已经有调度，先取消
    this.unscheduleTask(task.id);

    const options: CronScheduleOptions = {
      scheduled: true,
      timezone: 'Asia/Shanghai',
    };

    const job = cron.schedule(task.cronExpr, async () => {
      await this.executeTask(task);
    }, options);

    this.scheduledJobs.set(task.id, job);
    logger.debug(`已调度任务: ${task.id} (${task.cronExpr})`);
  }

  /**
   * 取消调度
   */
  private unscheduleTask(id: string): void {
    const job = this.scheduledJobs.get(id);
    if (job) {
      job.stop();
      this.scheduledJobs.delete(id);
      logger.debug(`已取消调度: ${id}`);
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(task: CronTask): Promise<void> {
    logger.info(`执行 Cron 任务: ${task.id} - ${task.description}`);

    try {
      // 构建回调数据
      const callback: CronTriggerCallback = {
        type: 'cron_trigger',
        taskId: task.id,
        taskDescription: task.description,
        taskContent: task.taskContent,
        chatId: task.chatId,
        timestamp: new Date().toISOString(),
      };

      // 发送回调
      const response = await fetch(this.config.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expert: 'cron-scheduler',
          sessionId: task.id,
          success: true,
          result: JSON.stringify(callback),
        }),
      });

      if (!response.ok) {
        throw new Error(`回调失败: ${response.status}`);
      }

      // 更新任务状态
      this.storage.updateCronTaskStatus(task.id, {
        lastRun: new Date().toISOString(),
        runCount: task.runCount + 1,
        lastError: null,
      });

      logger.info(`任务执行成功: ${task.id}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`任务执行失败: ${task.id}`, error);

      // 更新错误状态
      this.storage.updateCronTaskStatus(task.id, {
        lastRun: new Date().toISOString(),
        runCount: task.runCount + 1,
        lastError: errorMessage,
      });
    }
  }

  /**
   * 生成任务 ID
   */
  private generateTaskId(): string {
    return `cron-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * 任务对象转记录
   */
  private taskToRecord(task: CronTask): CronTaskRecord {
    return {
      id: task.id,
      description: task.description,
      cron_expr: task.cronExpr,
      task_content: task.taskContent,
      chat_id: task.chatId,
      enabled: task.enabled ? 1 : 0,
      silent: task.silent ? 1 : 0,
      last_run: task.lastRun?.toISOString() || null,
      last_error: task.lastError || null,
      last_result: task.lastResult || null,
      run_count: task.runCount,
      created_at: task.createdAt.toISOString(),
    };
  }

  /**
   * 记录转任务对象
   */
  private recordToTask(record: CronTaskRecord): CronTask {
    return {
      id: record.id,
      description: record.description,
      cronExpr: record.cron_expr,
      taskContent: record.task_content,
      chatId: record.chat_id,
      enabled: record.enabled === 1,
      silent: record.silent === 1,
      lastRun: record.last_run ? new Date(record.last_run) : undefined,
      lastError: record.last_error || undefined,
      lastResult: record.last_result || undefined,
      createdAt: new Date(record.created_at),
      runCount: record.run_count,
    };
  }

  /**
   * 停止所有调度
   */
  stop(): void {
    for (const [id, job] of this.scheduledJobs) {
      job.stop();
      logger.debug(`停止调度: ${id}`);
    }
    this.scheduledJobs.clear();
    this.isRunning = false;
    logger.info('CronManager 已停止');
  }

  /**
   * 获取状态
   */
  getStatus(): {
    isRunning: boolean;
    totalTasks: number;
    enabledTasks: number;
    scheduledJobs: number;
  } {
    const tasks = this.getAllTasks();
    return {
      isRunning: this.isRunning,
      totalTasks: tasks.length,
      enabledTasks: tasks.filter(t => t.enabled).length,
      scheduledJobs: this.scheduledJobs.size,
    };
  }
}
