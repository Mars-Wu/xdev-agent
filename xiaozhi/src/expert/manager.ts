// src/expert/manager.ts
// 专家管理器 - 管理专家配置、选择专家、生成专家 prompt

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { getDefaultModel } from '../config';

const logger = createLogger('expert-manager');

// 专家配置
export interface ExpertConfig {
  name: string;           // 专家名称
  description: string;    // 专家描述
  specialties: string[];  // 专长领域
  promptPath: string;     // prompt 文件路径
}

// 专家状态
export interface ExpertStatus {
  name: string;
  status: 'idle' | 'busy' | 'queued';
  currentTask?: string;
  lastActive?: Date;
  completedTasks: number;
  startTime?: Date;       // 任务开始时间（用于超时检测）
  processId?: number;     // 进程 ID
}

// 任务队列项
interface QueuedTask {
  expertName: string;
  task: string;
  workDir?: string;
  model?: string;
  queuedAt: Date;
}

// 专家间消息
export interface ExpertMessage {
  from: string;
  to: string;
  content: string;
  timestamp: Date;
}

// 专家管理器配置
export interface ExpertManagerConfig {
  maxConcurrent?: number;     // 最大并发数，默认 5
  defaultTimeout?: number;    // 默认超时时间（毫秒），默认 30 分钟
  preventRecursion?: boolean; // 防止专家直接调用专家（通过 /expert/call），但允许通过消息通信（/expert/message）
  maxTaskLength?: number;     // 任务描述最大长度，默认 10000
  maxMessagesCount?: number;  // 消息存储最大数量，默认 1000
}

// P0 安全验证：路径验证函数
function validateWorkDir(workDir: string | undefined): string {
  if (!workDir) return process.cwd();

  // 规范化路径
  const normalizedPath = path.resolve(workDir);

  // 检查路径是否在允许的范围内（用户主目录或 /tmp）
  const homeDir = os.homedir();
  const allowedPrefixes = [homeDir, '/tmp', '/var/tmp'];

  const isAllowed = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));
  if (!isAllowed) {
    throw new Error(`工作目录不在允许的范围内: ${workDir}`);
  }

  // 检查路径遍历攻击
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

  // 长度限制
  if (task.length > maxLength) {
    throw new Error(`任务描述过长 (${task.length} > ${maxLength})`);
  }

  // 检查危险字符（主要是控制字符）
  const dangerousPattern = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
  if (dangerousPattern.test(task)) {
    throw new Error('任务描述包含非法字符');
  }

  return task;
}

// 专家调用参数
export interface ExpertCallParams {
  expertName: string;
  task: string;
  workDir?: string;
  model?: string;
}

export class ExpertManager {
  private expertsDir: string;
  private experts: Map<string, ExpertConfig> = new Map();
  private expertStatus: Map<string, ExpertStatus> = new Map();
  private serverPort: number;

  // P0 安全功能
  private config: Required<ExpertManagerConfig>;
  private runningProcesses: Map<string, ChildProcess> = new Map();  // 正在运行的进程
  private taskQueue: QueuedTask[] = [];  // 任务队列
  private timeoutTimers: Map<string, NodeJS.Timeout> = new Map();   // 超时定时器
  private isExpertEnvironment: boolean = false;  // 当前是否在专家环境中运行

  // P1 功能
  private messages: ExpertMessage[] = [];  // 消息存储（简单实现，可后续改为数据库）
  private messageHandlers: ((msg: ExpertMessage) => void)[] = [];  // 消息处理器

  constructor(expertsDir?: string, serverPort: number = 8081, config?: ExpertManagerConfig) {
    this.expertsDir = expertsDir || path.join(os.homedir(), '.xiaozhi', 'experts');
    this.serverPort = serverPort;
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 5,  // 最大并发专家数
      defaultTimeout: config?.defaultTimeout ?? 30 * 60 * 1000,  // 30 分钟
      preventRecursion: config?.preventRecursion ?? true,  // 防止专家直接调用专家（但可以通过消息通信）
      maxTaskLength: config?.maxTaskLength ?? 10000,  // 任务描述最大长度
      maxMessagesCount: config?.maxMessagesCount ?? 1000,  // 消息存储最大数量
    };

    // 检测是否在专家环境中运行（通过环境变量）
    this.isExpertEnvironment = process.env.XIAOZHI_EXPERT_MODE === 'true';
    if (this.isExpertEnvironment) {
      logger.info('检测到专家环境模式');
    }
  }

  /**
   * 初始化：加载所有专家配置
   */
  async initialize(): Promise<void> {
    await this.loadExperts();
    logger.info(`已加载 ${this.experts.size} 个专家`);
  }

  /**
   * 加载所有专家配置
   */
  private async loadExperts(): Promise<void> {
    try {
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

            // 初始化状态
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

    // 从 prompt 中提取描述
    const descMatch = content.match(/^#\s+(.+)$/m);
    const description = descMatch ? descMatch[1] : name;

    // 从 prompt 中提取专长
    const specMatch = content.match(/专长:\s*(.+)$/m);
    const specialties = specMatch
      ? specMatch[1].split(/[,、，]/).map(s => s.trim())
      : [];

    return {
      name,
      description,
      specialties,
      promptPath,
    };
  }

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
  getExpertStatus(name: string): ExpertStatus | undefined {
    return this.expertStatus.get(name);
  }

  /**
   * 获取所有专家状态
   */
  getAllStatus(): ExpertStatus[] {
    return Array.from(this.expertStatus.values());
  }

  /**
   * 根据任务类型推荐专家
   */
  recommendExpert(taskDescription: string): string | null {
    const task = taskDescription.toLowerCase();

    // 简单的关键词匹配
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
   * 生成完整的专家 prompt（包含任务和回调指令）
   */
  async generateExpertPrompt(expertName: string, task: string): Promise<string> {
    const config = this.experts.get(expertName);
    if (!config) {
      throw new Error(`专家 ${expertName} 不存在`);
    }

    // 读取基础 prompt
    const basePrompt = await fs.readFile(config.promptPath, 'utf-8');

    // 动态生成回调 URL（使用 serverPort）
    const callbackUrl = `http://localhost:${this.serverPort}/expert/complete`;

    // 构建完整 prompt
    const fullPrompt = `${basePrompt}

---

## 当前任务

${task}

## 完成后回调

任务完成后，**必须**执行以下命令报告结果：

\`\`\`bash
curl -X POST ${callbackUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"expert":"${expertName}","success":true,"result":"任务结果摘要"}'
\`\`\`

## 与其他专家通信

如果需要与其他专家协作，可以发送消息（通过小智中转）：

\`\`\`bash
curl -X POST http://localhost:${this.serverPort}/expert/message \\
  -H "Content-Type: application/json" \\
  -d '{"from":"${expertName}","to":"目标专家名","content":"消息内容"}'
\`\`\`

**注意**：你不能直接调用其他专家（/expert/call），只能通过消息通信。

## 重要提醒

1. 完成任务后，**必须**调用上述 curl 命令报告结果
2. 不要跳过报告步骤
3. 即使遇到问题，也要报告失败原因（success: false）
`;

    return fullPrompt;
  }

  /**
   * 调用专家（spawn 进程，不等待）
   * P0: 添加并发限制、递归检测、超时机制、参数验证
   * P1: 添加任务队列
   */
  async callExpert(params: ExpertCallParams): Promise<void> {
    const { expertName, task, workDir, model } = params;

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
      // P1: 加入任务队列
      logger.info(`并发数已达上限 (${currentRunning}/${this.config.maxConcurrent})，任务加入队列`);
      this.taskQueue.push({
        expertName,
        task,
        workDir,
        model,
        queuedAt: new Date(),
      });

      // 更新状态为排队中
      const status = this.expertStatus.get(expertName);
      if (status) {
        status.status = 'queued';
        status.currentTask = task;
      }
      return;
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

    // 生成完整 prompt
    const fullPrompt = await this.generateExpertPrompt(expertName, task);

    // 构建 claude 命令，设置环境变量标记专家模式
    const args = [
      '--print',
      '--dangerously-skip-permissions',
      '--model', model || getDefaultModel(),
      fullPrompt,
    ];

    logger.info(`调用专家 ${expertName}: ${task.slice(0, 50)}...`);

    // spawn 进程，不等待
    const proc = spawn('claude', args, {
      cwd: validatedWorkDir,
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        XIAOZHI_EXPERT_MODE: 'true',  // 标记为专家环境
      },
    });

    // 记录进程
    this.runningProcesses.set(expertName, proc);
    if (status) {
      status.processId = proc.pid;
    }

    proc.unref();

    proc.on('error', (error) => {
      logger.error(`专家 ${expertName} 启动失败:`, error);
      this.cleanupExpert(expertName, false);
    });

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        logger.warn(`专家 ${expertName} 异常退出 (code: ${code})`);
        // P1 修复：异常退出时也要清理资源，防止状态不一致
        // 使用 setTimeout 延迟清理，给完成回调一些时间
        setTimeout(() => {
          const status = this.expertStatus.get(expertName);
          // 如果状态仍然是 busy，说明完成回调没有被调用，需要清理
          if (status && status.status === 'busy') {
            logger.warn(`专家 ${expertName} 异常退出后未收到完成回调，执行清理`);
            this.cleanupExpert(expertName, false);
          }
        }, 5000);  // 等待 5 秒
      }
    });

    // P0: 设置超时定时器
    this.setTimeout(expertName);

    logger.info(`专家 ${expertName} 已启动 (PID: ${proc.pid})`);
  }

  /**
   * P0: 获取当前运行中的专家数量
   */
  private getRunningCount(): number {
    let count = 0;
    for (const status of this.expertStatus.values()) {
      if (status.status === 'busy') {
        count++;
      }
    }
    return count;
  }

  /**
   * P0: 设置专家超时
   */
  private setTimeout(expertName: string): void {
    // 清除现有定时器
    const existingTimer = this.timeoutTimers.get(expertName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      logger.warn(`专家 ${expertName} 运行超时，强制终止`);
      this.forceStopExpert(expertName, '超时');
    }, this.config.defaultTimeout);

    this.timeoutTimers.set(expertName, timer);
  }

  /**
   * P0: 强制停止专家
   */
  forceStopExpert(expertName: string, reason: string = '手动停止'): void {
    const proc = this.runningProcesses.get(expertName);
    if (proc && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');  // 杀死进程组
        logger.info(`专家 ${expertName} 已被强制停止: ${reason}`);
      } catch (error) {
        logger.warn(`停止专家 ${expertName} 失败:`, error);
      }
    }
    this.cleanupExpert(expertName, false);
  }

  /**
   * P0: 清理专家资源
   */
  private cleanupExpert(expertName: string, success: boolean): void {
    // 清除定时器
    const timer = this.timeoutTimers.get(expertName);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(expertName);
    }

    // 移除进程记录
    this.runningProcesses.delete(expertName);

    // 更新状态
    const status = this.expertStatus.get(expertName);
    if (status) {
      status.status = 'idle';
      status.currentTask = undefined;
      status.startTime = undefined;
      status.processId = undefined;
      if (success) {
        status.completedTasks++;
      }
      status.lastActive = new Date();
    }

    // P1: 处理队列中的下一个任务
    this.processQueue();
  }

  /**
   * P1: 处理任务队列
   */
  private processQueue(): void {
    if (this.taskQueue.length === 0) {
      return;
    }

    // 检查是否可以启动新任务
    const currentRunning = this.getRunningCount();
    if (currentRunning >= this.config.maxConcurrent) {
      return;
    }

    // 取出队列中的第一个任务
    const task = this.taskQueue.shift();
    if (task) {
      logger.info(`从队列中启动任务: ${task.expertName}`);
      // 异步调用，不等待
      this.callExpert({
        expertName: task.expertName,
        task: task.task,
        workDir: task.workDir,
        model: task.model,
      }).catch(err => {
        logger.error(`队列任务启动失败:`, err);
      });
    }
  }

  /**
   * 专家完成回调处理
   */
  handleExpertComplete(expertName: string, success: boolean, result: string): void {
    this.cleanupExpert(expertName, success);
    logger.info(`专家 ${expertName} 完成: success=${success}, result: ${result.slice(0, 100)}`);
  }

  /**
   * 获取专家列表描述（给小智用）
   */
  getExpertsDescription(): string {
    const experts = this.getExperts();
    if (experts.length === 0) {
      return '当前没有可用的专家';
    }

    const lines = experts.map(e => {
      const status = this.expertStatus.get(e.name);
      const statusText = status?.status === 'busy' ? '(忙碌中)' :
                         status?.status === 'queued' ? '(排队中)' : '(空闲)';
      return `- **${e.name}** ${statusText}: ${e.description}`;
    });

    return lines.join('\n');
  }

  // ==================== P1 功能 ====================

  /**
   * P1: 动态创建专家
   */
  async createExpert(name: string, description: string, specialties: string[], customPrompt?: string): Promise<ExpertConfig> {
    // 检查专家是否已存在
    if (this.experts.has(name)) {
      throw new Error(`专家 ${name} 已存在`);
    }

    // 创建专家目录
    const expertDir = path.join(this.expertsDir, name);
    await fs.mkdir(expertDir, { recursive: true });

    // 生成 prompt 文件
    const promptContent = customPrompt || this.generateDefaultPrompt(name, description, specialties);
    const promptPath = path.join(expertDir, 'CLAUDE.md');
    await fs.writeFile(promptPath, promptContent, 'utf-8');

    // 创建配置
    const config: ExpertConfig = {
      name,
      description,
      specialties,
      promptPath,
    };

    // 注册专家
    this.experts.set(name, config);
    this.expertStatus.set(name, {
      name,
      status: 'idle',
      completedTasks: 0,
    });

    logger.info(`动态创建专家: ${name}`);
    return config;
  }

  /**
   * P1: 生成默认的专家 prompt
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

  /**
   * P1: 删除专家
   */
  async deleteExpert(name: string): Promise<boolean> {
    const status = this.expertStatus.get(name);
    if (status && status.status === 'busy') {
      throw new Error(`专家 ${name} 正在运行中，无法删除`);
    }

    const config = this.experts.get(name);
    if (!config) {
      return false;
    }

    // 删除目录
    try {
      const expertDir = path.dirname(config.promptPath);
      await fs.rm(expertDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn(`删除专家目录失败:`, error);
    }

    // 移除注册
    this.experts.delete(name);
    this.expertStatus.delete(name);

    logger.info(`删除专家: ${name}`);
    return true;
  }

  /**
   * P1: 发送消息给专家（通过小智中转）
   */
  async sendMessage(from: string, to: string, content: string): Promise<void> {
    // 检查目标专家是否存在
    if (!this.experts.has(to)) {
      throw new Error(`目标专家 ${to} 不存在`);
    }

    const message: ExpertMessage = {
      from,
      to,
      content,
      timestamp: new Date(),
    };

    // 存储消息
    this.messages.push(message);

    // P1 修复：限制消息数量，超过限制时删除最旧的消息
    while (this.messages.length > this.config.maxMessagesCount) {
      this.messages.shift();
    }

    // 通知消息处理器
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('消息处理器错误:', error);
      }
    }

    logger.info(`消息: ${from} -> ${to}: ${content.slice(0, 50)}...`);
  }

  /**
   * P1: 获取专家的消息
   */
  getMessages(expertName: string, limit: number = 10): ExpertMessage[] {
    return this.messages
      .filter(m => m.to === expertName || m.from === expertName)
      .slice(-limit);
  }

  /**
   * P1: 注册消息处理器
   */
  onMessage(handler: (msg: ExpertMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * P1: 获取任务队列状态
   */
  getQueueStatus(): { queueLength: number; runningCount: number; maxConcurrent: number; tasks: QueuedTask[] } {
    return {
      queueLength: this.taskQueue.length,
      runningCount: this.getRunningCount(),
      maxConcurrent: this.config.maxConcurrent,
      tasks: [...this.taskQueue],
    };
  }

  /**
   * P1: 清空任务队列
   */
  clearQueue(): number {
    const count = this.taskQueue.length;
    this.taskQueue = [];
    logger.info(`已清空任务队列，移除 ${count} 个任务`);
    return count;
  }

  /**
   * 获取配置
   */
  getConfig(): Required<ExpertManagerConfig> {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ExpertManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('更新专家管理器配置:', newConfig);
  }
}

// 导出单例
let expertManager: ExpertManager | null = null;

export function getExpertManager(expertsDir?: string, serverPort?: number): ExpertManager {
  if (!expertManager) {
    expertManager = new ExpertManager(expertsDir, serverPort);
  }
  return expertManager;
}
