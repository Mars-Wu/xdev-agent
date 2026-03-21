// src/expert/manager.ts
// 统一专家管理器 - 管理专家配置、调用、会话
// 整合了原 Worker 和专家的功能

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { createLogger } from '../utils/logger';
import { getDefaultModel, PATHS } from '../config';
import { SQLiteStorage } from '../storage/sqlite';
import { SessionManager } from './session-manager';
import { ExpertExecutor } from './executor';
import {
  ExpertConfig,
  ExpertRuntimeStatus,
  ExpertCallParams,
  CreateExpertParams,
  ExpertManagerConfig,
  QueuedTask,
  QueueStatus,
  ExpertSession,
  DEFAULT_CONTEXT_CONFIG,
} from './types';

const logger = createLogger('expert-manager');

// P0 安全验证：路径验证函数
function validateWorkDir(workDir: string | undefined): string {
  if (!workDir) return process.cwd();

  const normalizedPath = path.resolve(workDir);
  const homeDir = os.homedir();
  const allowedPrefixes = [homeDir, '/tmp', '/var/tmp'];

  const isAllowed = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));
  if (!isAllowed) {
    throw new Error(`工作目录不在允许的范围内: ${workDir}`);
  }

  if (workDir.includes('..') || workDir.includes('\0')) {
    throw new Error(`无效的工作目录路径: ${workDir}`);
  }

  return normalizedPath;
}

// P0 安全验证：任务内容验证函数
function validateTask(task: string, maxLength: number): string {
  if (!task || typeof task !== 'string') {
    throw new Error('任务描述不能为空');
  }

  if (task.length > maxLength) {
    throw new Error(`任务描述过长 (${task.length} > ${maxLength})`);
  }

  const dangerousPattern = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
  if (dangerousPattern.test(task)) {
    throw new Error('任务描述包含非法字符');
  }

  return task;
}

/**
 * 统一专家管理器
 *
 * 会话策略：
 * - shouldContinue: true  -> 使用 --continue，继续该工作目录的最近会话
 * - shouldContinue: false -> 新会话（默认）
 *
 * Claude CLI 会话是基于工作目录隔离的，--continue 会自动选择该目录最近的会话
 */
export class ExpertManager {
  private expertsDir: string;
  private storage: SQLiteStorage;
  private sessionManager: SessionManager;
  private executor: ExpertExecutor;
  private serverPort: number;

  // 专家配置和状态
  private experts: Map<string, ExpertConfig> = new Map();
  private expertStatus: Map<string, ExpertRuntimeStatus> = new Map();

  // 配置
  private config: Required<ExpertManagerConfig>;

  // 任务队列
  private taskQueue: QueuedTask[] = [];

  // 是否在专家环境中
  private isExpertEnvironment: boolean;

  constructor(
    storage: SQLiteStorage,
    expertsDir?: string,
    serverPort: number = 8081,
    config?: ExpertManagerConfig
  ) {
    this.storage = storage;
    this.expertsDir = expertsDir || PATHS.EXPERTS_DIR;
    this.serverPort = serverPort;

    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 5,
      defaultTimeout: config?.defaultTimeout ?? 30 * 60 * 1000,
      preventRecursion: config?.preventRecursion ?? true,
      maxTaskLength: config?.maxTaskLength ?? 10000,
      maxMessagesCount: config?.maxMessagesCount ?? 1000,
      sessionRetentionDays: config?.sessionRetentionDays ?? 30,
      contextCompaction: {
        ...DEFAULT_CONTEXT_CONFIG,
        ...config?.contextCompaction,
      },
    };

    this.isExpertEnvironment = process.env.XIAOZHI_EXPERT_MODE === 'true';

    // 初始化会话管理器和执行器
    this.sessionManager = new SessionManager({
      storage: this.storage,
      expertsDir: this.expertsDir,
      sessionRetentionDays: this.config.sessionRetentionDays,
    });

    this.executor = new ExpertExecutor({
      sessionManager: this.sessionManager,
      serverPort: this.serverPort,
      defaultTimeout: this.config.defaultTimeout,
      preventRecursion: this.config.preventRecursion,
    });

    // 设置执行器回调
    this.executor.setCallbacks({
      onComplete: (sessionId, result) => {
        this.handleExecutionComplete(sessionId, result);
      },
      onError: (sessionId, error) => {
        this.handleExecutionError(sessionId, error);
      },
      onTerminated: (sessionId, reason) => {
        this.handleSessionTerminated(sessionId, reason);
      },
    });
  }

  /**
   * 初始化：加载所有专家配置
   */
  async initialize(): Promise<void> {
    await this.loadExperts();
    await this.syncExpertsToDb();
    logger.info(`已加载 ${this.experts.size} 个专家`);
  }

  /**
   * 加载所有专家配置
   */
  private async loadExperts(): Promise<void> {
    try {
      await fs.mkdir(this.expertsDir, { recursive: true });
      const dirs = await fs.readdir(this.expertsDir);

      for (const dir of dirs) {
        const expertPath = path.join(this.expertsDir, dir);
        const stat = await fs.stat(expertPath);

        if (stat.isDirectory()) {
          const promptPath = path.join(expertPath, 'CLAUDE.md');
          try {
            await fs.access(promptPath);
            const config = await this.loadExpertConfig(dir, promptPath);
            this.experts.set(dir, config);
            this.expertStatus.set(dir, {
              name: dir,
              status: 'idle',
              completedTasks: 0,
            });
          } catch {
            logger.warn(`专家目录 ${dir} 没有 CLAUDE.md`);
          }
        }
      }
    } catch (error) {
      logger.warn('加载专家配置失败:', error);
    }
  }

  /**
   * 加载单个专家配置
   */
  private async loadExpertConfig(name: string, promptPath: string): Promise<ExpertConfig> {
    const content = await fs.readFile(promptPath, 'utf-8');

    const descMatch = content.match(/^#\s+(.+)$/m);
    const description = descMatch ? descMatch[1] : name;

    const specMatch = content.match(/专长:\s*(.+)$/m);
    const specialties = specMatch
      ? specMatch[1].split(/[,、，]/).map(s => s.trim())
      : [];

    return {
      id: this.generateExpertId(name),
      name,
      description,
      specialties,
      type: 'predefined',
      workDir: path.join(this.expertsDir, name),
      promptPath,
      stats: {
        totalCalls: 0,
        successCount: 0,
        createdAt: new Date(),
      },
    };
  }

  /**
   * 同步专家到数据库
   *
   * 重要：如果专家已存在于数据库，必须使用数据库中的 ID，而不是新生成的 ID。
   * 否则创建会话时外键约束会失败（内存中的 ID 与数据库中的 ID 不一致）。
   */
  private async syncExpertsToDb(): Promise<void> {
    for (const config of this.experts.values()) {
      const existing = this.storage.getExpertByName(config.name);
      if (!existing) {
        this.storage.saveExpert(config);
      } else {
        // 关键修复：使用数据库中已存在的 ID，而不是内存中新生成的 ID
        config.id = existing.id;
        try {
          config.stats = JSON.parse(existing.stats);
        } catch {
          // 使用默认统计
        }
      }
    }
  }

  /**
   * 生成专家 ID
   */
  private generateExpertId(name: string): string {
    return `expert-${name}-${crypto.randomBytes(4).toString('hex')}`;
  }

  // ==================== 专家管理 ====================

  /**
   * 获取所有专家列表
   */
  getExperts(): ExpertConfig[] {
    return Array.from(this.experts.values());
  }

  /**
   * 获取专家配置
   */
  getExpert(name: string): ExpertConfig | undefined {
    return this.experts.get(name);
  }

  /**
   * 获取专家状态
   */
  getExpertStatus(name: string): ExpertRuntimeStatus | undefined {
    return this.expertStatus.get(name);
  }

  /**
   * 获取所有专家状态
   */
  getAllStatus(): ExpertRuntimeStatus[] {
    return Array.from(this.expertStatus.values());
  }

  /**
   * 根据任务类型推荐专家
   */
  recommendExpert(taskDescription: string): string | null {
    const task = taskDescription.toLowerCase();

    const keywords: Record<string, string[]> = {
      coder: ['代码', 'code', '重构', 'refactor', 'bug', '修复', '写', '实现', '编程'],
      analyst: ['分析', '日志', 'log', '数据', '统计', '诊断', '问题'],
      operator: ['部署', '运维', '服务', '重启', '监控', '性能', '系统'],
      researcher: ['调研', '研究', '文档', '收集', '整理', '了解'],
    };

    for (const [expert, words] of Object.entries(keywords)) {
      if (words.some(w => task.includes(w))) {
        return expert;
      }
    }

    return null;
  }

  /**
   * 动态创建专家
   */
  async createExpert(params: CreateExpertParams): Promise<ExpertConfig> {
    const { name, description, specialties, customPrompt, type } = params;

    if (this.experts.has(name)) {
      throw new Error(`专家 ${name} 已存在`);
    }

    const expertDir = path.join(this.expertsDir, name);
    await fs.mkdir(expertDir, { recursive: true });

    const promptContent = customPrompt || this.generateDefaultPrompt(name, description, specialties);
    const promptPath = path.join(expertDir, 'CLAUDE.md');
    await fs.writeFile(promptPath, promptContent, 'utf-8');

    const config: ExpertConfig = {
      id: this.generateExpertId(name),
      name,
      description,
      specialties,
      type: type || 'dynamic',
      workDir: expertDir,
      promptPath,
      customPrompt,
      stats: {
        totalCalls: 0,
        successCount: 0,
        createdAt: new Date(),
      },
    };

    this.storage.saveExpert(config);
    this.experts.set(name, config);
    this.expertStatus.set(name, {
      name,
      status: 'idle',
      completedTasks: 0,
    });

    logger.info(`创建专家: ${name}`);
    return config;
  }

  /**
   * 删除专家
   */
  async deleteExpert(name: string): Promise<boolean> {
    const status = this.expertStatus.get(name);
    if (status && status.status === 'busy') {
      throw new Error(`专家 ${name} 正在运行中，无法删除`);
    }

    const config = this.experts.get(name);
    if (!config) return false;

    try {
      const expertDir = path.dirname(config.promptPath);
      await fs.rm(expertDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`删除专家目录失败:`, error);
    }

    this.storage.deleteExpert(config.id);
    this.experts.delete(name);
    this.expertStatus.delete(name);

    logger.info(`删除专家: ${name}`);
    return true;
  }

  /**
   * 生成默认的专家 prompt
   */
  private generateDefaultPrompt(name: string, description: string, specialties: string[]): string {
    return `# ${description}

你是小智团队的 ${name} 专家。

## 身份
- 名称: ${name}
- 专长: ${specialties.join('、')}

## 工作规则
1. 专注于你的专业领域
2. 遵循最佳实践
3. 完成任务后报告结果

## 注意事项
- 你是小智创建的专家，专注于特定任务
- 完成任务后必须通过回调报告结果
`;
  }

  // ==================== 专家调用 ====================

  /**
   * 调用专家
   *
   * @param params.shouldContinue - true: 使用 --continue 继续该目录最近会话; false: 新会话（默认）
   */
  async callExpert(params: ExpertCallParams): Promise<{ sessionId: string }> {
    const { expertName, task, workDir, model, category, tags, shouldContinue } = params;

    // P0: 参数验证
    const validatedTask = validateTask(task, this.config.maxTaskLength);
    const validatedWorkDir = validateWorkDir(workDir);

    const config = this.experts.get(expertName);
    if (!config) {
      throw new Error(`专家 ${expertName} 不存在`);
    }

    // P0: 递归调用检测
    if (this.config.preventRecursion && this.isExpertEnvironment) {
      throw new Error('递归调用被禁止：专家不能调用其他专家');
    }

    // P0: 并发限制检查
    const currentRunning = this.getRunningCount();
    if (currentRunning >= this.config.maxConcurrent) {
      logger.info(`并发数已达上限 (${currentRunning}/${this.config.maxConcurrent})，任务加入队列`);
      this.taskQueue.push({
        id: `queue-${Date.now()}`,
        expertName,
        task,
        workDir: validatedWorkDir,
        model,
        category,
        tags,
        queuedAt: new Date(),
      });

      const status = this.expertStatus.get(expertName);
      if (status) {
        status.status = 'queued';
        status.currentTask = task;
      }

      throw new Error('并发数已达上限，任务已加入队列');
    }

    // 检查专家是否已被占用
    const status = this.expertStatus.get(expertName);
    if (status && status.status === 'busy') {
      throw new Error(`专家 ${expertName} 正在忙碌中，请稍后再试`);
    }

    // 更新状态为忙碌
    if (status) {
      status.status = 'busy';
      status.currentTask = task;
      status.startTime = new Date();
    }

    // 创建会话
    const session = await this.sessionManager.createSession(config, validatedTask, {
      model: model || getDefaultModel(),
      workDir: validatedWorkDir,
      category,
      tags,
    });

    // 更新状态中的会话 ID
    if (status) {
      status.sessionId = session.id;
    }

    // 执行（传入 shouldContinue 参数）
    await this.executor.execute(config, session, params);

    logger.info(`专家 ${expertName} 已启动 (Session: ${session.id}, Continue: ${shouldContinue || false})`);
    return { sessionId: session.id };
  }

  /**
   * 停止专家
   */
  forceStopExpert(expertName: string, reason: string = '手动停止'): void {
    const status = this.expertStatus.get(expertName);
    if (!status || !status.sessionId) {
      logger.warn(`专家 ${expertName} 没有运行中的会话`);
      return;
    }

    this.executor.stop(status.sessionId, reason);
    this.cleanupExpert(expertName, false);
  }

  // ==================== 会话管理 ====================

  /**
   * 获取会话
   */
  getSession(sessionId: string): ExpertSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * 获取专家的会话历史
   */
  getExpertSessions(expertName: string, limit: number = 50): ExpertSession[] {
    const config = this.experts.get(expertName);
    if (!config) return [];
    return this.sessionManager.getExpertSessions(config.id, limit);
  }

  /**
   * 获取运行中的会话
   */
  getRunningSessions(): ExpertSession[] {
    return this.sessionManager.getRunningSessions();
  }

  // ==================== 回调处理 ====================

  /**
   * 处理执行完成
   *
   * 状态保护：如果会话已处于终态，忽略此次回调
   */
  private handleExecutionComplete(sessionId: string, result: { success: boolean; output?: string; duration: number }): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn(`会话 ${sessionId} 不存在`);
      return;
    }

    // 状态保护：检查会话是否已处于终态
    if (this.sessionManager.isTerminalState(sessionId)) {
      const currentStatus = this.sessionManager.getSessionStatus(sessionId);
      logger.warn(
        `会话 ${sessionId} 已处于终态(${currentStatus})，忽略完成回调 ` +
        `(success=${result.success})`
      );
      return;
    }

    const updated = this.sessionManager.completeSession(sessionId, result.success, result.output || '');
    if (!updated) {
      logger.warn(`会话 ${sessionId} 状态更新失败，可能已被其他进程处理`);
      return;
    }

    this.cleanupExpert(session.expertName, result.success);

    const config = this.experts.get(session.expertName);
    if (config) {
      config.stats.totalCalls++;
      if (result.success) config.stats.successCount++;
      config.stats.lastUsedAt = new Date();
      this.storage.updateExpertStats(config.id, config.stats);
    }

    logger.info(`会话 ${sessionId} 完成: success=${result.success}`);
  }

  /**
   * 处理执行错误
   */
  private handleExecutionError(sessionId: string, error: Error): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    // 状态保护：检查会话是否已处于终态
    if (this.sessionManager.isTerminalState(sessionId)) {
      logger.warn(`会话 ${sessionId} 已处于终态，忽略错误回调`);
      return;
    }

    const updated = this.sessionManager.completeSession(sessionId, false, error.message);
    if (updated) {
      this.cleanupExpert(session.expertName, false);
    }
  }

  /**
   * 处理会话终止（超时等场景）
   */
  private handleSessionTerminated(sessionId: string, reason: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const terminated = this.sessionManager.terminateSession(sessionId, reason);
    if (terminated) {
      this.cleanupExpert(session.expertName, false);
    }
  }

  /**
   * 专家完成回调处理（供外部调用）
   *
   * 状态保护：如果会话已被终止（超时等），忽略回调
   */
  handleExpertComplete(sessionId: string, success: boolean, result: string): void {
    // 检查会话状态
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn(`[Callback] 会话 ${sessionId} 不存在，忽略回调`);
      return;
    }

    const currentStatus = session.status;

    // 状态保护：已终止的会话不接受回调
    if (currentStatus === 'terminated') {
      logger.warn(
        `[Callback] 会话 ${sessionId} 已被终止，忽略回调 ` +
        `(success=${success}, result=${result.slice(0, 50)}...)`
      );
      return;
    }

    // 已完成/失败的会话也不应被覆盖
    if (currentStatus === 'completed' || currentStatus === 'failed') {
      logger.warn(
        `[Callback] 会话 ${sessionId} 已处于终态(${currentStatus})，忽略重复回调`
      );
      return;
    }

    logger.info(`[Callback] 专家 ${session.expertName} 完成: sessionId=${sessionId}, success=${success}`);
    this.handleExecutionComplete(sessionId, { success, output: result, duration: 0 });
  }

  // ==================== 任务队列 ====================

  private getRunningCount(): number {
    return this.executor.getRunningCount();
  }

  getQueueStatus(): QueueStatus {
    return {
      queueLength: this.taskQueue.length,
      runningCount: this.getRunningCount(),
      maxConcurrent: this.config.maxConcurrent,
      tasks: [...this.taskQueue],
    };
  }

  clearQueue(): number {
    const count = this.taskQueue.length;
    this.taskQueue = [];
    logger.info(`已清空任务队列，移除 ${count} 个任务`);
    return count;
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    const currentRunning = this.getRunningCount();
    if (currentRunning >= this.config.maxConcurrent) return;

    const task = this.taskQueue.shift();
    if (task) {
      logger.info(`从队列中启动任务: ${task.expertName}`);
      this.callExpert({
        expertName: task.expertName,
        task: task.task,
        workDir: task.workDir,
        model: task.model,
        category: task.category,
        tags: task.tags,
      }).catch(err => logger.error(`队列任务启动失败:`, err));
    }
  }

  private cleanupExpert(expertName: string, success: boolean): void {
    const status = this.expertStatus.get(expertName);
    if (status) {
      status.status = 'idle';
      status.currentTask = undefined;
      status.startTime = undefined;
      status.sessionId = undefined;
      if (success) status.completedTasks++;
      status.lastActive = new Date();
    }
    this.processQueue();
  }

  // ==================== 工具方法 ====================

  getExpertsDescription(): string {
    const experts = this.getExperts();
    if (experts.length === 0) return '当前没有可用的专家';

    return experts.map(e => {
      const status = this.expertStatus.get(e.name);
      const statusText = status?.status === 'busy' ? '(忙碌中)' :
                         status?.status === 'queued' ? '(排队中)' : '(空闲)';
      return `- **${e.name}** ${statusText}: ${e.description}`;
    }).join('\n');
  }

  getConfig(): Required<ExpertManagerConfig> {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ExpertManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('更新专家管理器配置:', newConfig);
  }
}

// 导出单例
let expertManager: ExpertManager | null = null;

export function getExpertManager(
  storage: SQLiteStorage,
  expertsDir?: string,
  serverPort?: number
): ExpertManager {
  if (!expertManager) {
    expertManager = new ExpertManager(storage, expertsDir, serverPort);
  }
  return expertManager;
}
