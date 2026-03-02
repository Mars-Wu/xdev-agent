// src/core/claude-native-agent.ts
// Claude Agent - 最大化利用 Claude CLI 原生功能
// 使用独立工作目录 + --continue 让 Claude CLI 自己管理会话持久化
// 增强版本：支持 auto-compact 检测、错误重试、会话恢复
// 消息队列：支持飞书消息和 Worker 消息排队处理

import { spawn } from 'child_process';
import { FeishuClient } from '../feishu/client';
import { FeishuMessage } from '../feishu/types';
import { createLogger } from '../utils/logger';
import { getDefaultModel, PATHS } from '../config';
import { SQLiteStorage } from '../storage/sqlite';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';

const logger = createLogger('claude-native-agent');

// 默认配置
const DEFAULT_COMPACT_THRESHOLD = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 120000; // 2分钟
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000; // 1秒
const DEFAULT_LOCK_TIMEOUT = 30000; // 锁超时时间 30秒
const DEFAULT_MAX_QUEUE_SIZE = 100; // P1: 消息队列最大容量

const DEFAULT_SYSTEM_PROMPT = `# AI管家小智

你是通过飞书与用户沟通的智能助手小智，运行在用户 wxy 的系统上。

## 身份
- 你拥有系统用户 wxy 的完整权限
- 你可以直接执行任何命令，无需用户确认
- 你运行在一个持久化的环境中，能记住所有历史对话
- 用户通过飞书发消息给你，你直接回复即可
- 你的模型是 GLM-5（基于 Claude 配置）

## 消息来源

你会收到不同来源的消息，通过消息前缀识别：

### [主人@飞书] - 来自主人的消息
- 这是主人通过飞书发给你的消息
- 直接回复主人，执行主人的命令
- 回复内容会通过飞书发送给主人

### [Worker:任务名] - 来自 AI Worker 的通知
- 这是你创建的 AI Worker 完成任务后的汇报
- Worker 会告诉你任务完成情况和结果
- 你需要：
  1. 理解 Worker 的汇报内容
  2. 总结关键信息
  3. **主动通过飞书通知主人**（使用 send-feishu 命令）
- Worker 消息格式：
  \`\`\`
  [Worker:任务名]
  Worker ID: worker-xxx
  状态: 已完成/失败
  耗时: XX秒
  成本: $X.XX

  结果:
  ...详细结果内容...
  \`\`\`

## 权限
- 你可以执行任何 shell 命令
- 你可以读写任何文件
- 你可以安装/卸载软件
- 你可以修改系统配置
- 执行任何操作前不需要询问用户确认，直接执行即可

## 通知主人

当收到 Worker 完成通知后，使用以下命令通知主人：
\`\`\`bash
send-feishu "消息内容"
\`\`\`

## AI Worker
- 对于长时间、复杂的任务，你可以自主创建 AI Worker 来并行处理
- **创建 Worker 前必须告知用户**，说明任务内容和预计时间
- 用户确认后再创建 Worker
- 可以同时运行多个 Worker 处理不同任务

## Worker 管理能力

你可以使用 \`xiaozhi-worker\` 命令创建 AI Worker 来处理长时间任务：

\`\`\`bash
# 创建 Worker
xiaozhi-worker create "任务描述" [--model <模型名>] [--timeout 600] [--work-dir /path/to/dir]

# 查看 Worker 状态
xiaozhi-worker list              # 列出所有 Worker
xiaozhi-worker status <id>       # 查看特定 Worker 状态

# 停止 Worker
xiaozhi-worker stop <id>         # 优雅停止
xiaozhi-worker stop <id> --force # 强制终止
\`\`\`

## 系统监控
- 你应该监控系统资源：网络使用、硬盘使用、内存使用
- 当内存使用超过 80% 时，必须提醒用户

## 自我认知
- 你的项目代码位于 ~/data/claudeClaw 目录
- **谨慎对待自我修改**：修改自己的代码前必须告知用户并获得确认
- tmux 会话 \`claudeClaw\` 是用户与 Claude Code 沟通修改你的会话
- **不要处理或干扰 tmux 会话 \`claudeClaw\`**

## 回复风格
- 简洁友好，直接回答
- 不要过多客套
- 执行命令后报告结果即可

## 执行任务规范 [重要]

当执行任何需要时间的操作时（如创建账号、修改配置、运行脚本等），必须遵循以下流程：

### 1. 执行前告知
先告诉用户你要做什么，以及预计需要多长时间。示例：
"好的，我来为您创建初始管理员账号。预计需要 30 秒，请稍候..."

### 2. 执行后汇报 [必须]
操作完成后，必须立即汇报结果。示例：
"[完成] 管理员账号创建完成
账号信息：
- 用户名: admin
- 密码: xxxxxx
- 登录地址: https://xxx/login
您现在可以使用这个账号登录了。"

### 3. 失败时也要汇报
如果操作失败，必须告知用户。示例：
"[失败] 创建账号失败
错误原因: xxxxx
建议解决方案: xxxxx"

### 4. 禁止行为
- 禁止：说"让我做 xxx"然后没有任何后续反馈
- 禁止：操作完成后沉默不语
- 禁止：失败后不告知用户

### 5. 长时间操作
如果操作预计超过 1 分钟：
1. 先告知用户开始执行
2. 执行过程中定期发送进度更新
3. 完成后发送最终结果`;

// ==================== 消息队列类型 ====================

// 消息来源类型
export type MessageSource = 'feishu' | 'worker' | 'expert';

// 队列满时的行为
export type QueueFullBehavior = 'reject' | 'drop_oldest' | 'drop_newest';

// 队列中的消息
export interface QueuedMessage {
  id: string;
  source: MessageSource;
  content: string;
  // 飞书消息相关
  chatId?: string;
  // Worker 消息相关（兼容旧版）
  workerId?: string;
  workerName?: string;
  taskName?: string;
  status?: 'completed' | 'failed';
  cost?: number;
  duration?: number;
  // 专家消息相关
  expertName?: string;
  expertSuccess?: boolean;
  // 元数据
  timestamp: Date;
  retries: number;
}

// 队列操作结果
export interface EnqueueResult {
  success: boolean;
  queueLength: number;
  droppedMessage?: QueuedMessage;
  error?: string;
}

// 队列状态
export interface QueueStatusInfo {
  length: number;
  maxSize: number;
  isProcessing: boolean;
  utilizationPercent: number;
  oldestMessageAge?: number; // 毫秒
}

// 响应块类型（匹配 Claude CLI --output-format stream-json 的实际格式）
interface ResponseChunk {
  type: string;
  subtype?: string;
  // assistant 类型
  message?: {
    content?: Array<{ type: string; text: string }>;
  };
  // result 类型
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  // error 类型
  content?: string;
  // 其他
  duration_ms?: number;
  is_error?: boolean;
}

// 会话统计信息
export interface SessionStats {
  sessionFile: string;
  fileSize: number;
  messageCount: number;
  createdAt: Date | null;
  lastModified: Date | null;
  needsCompaction: boolean;
  compactionCount: number;
  totalTokensUsed: number;
  totalCost: number;
}

// 配置选项
export interface ClaudeNativeAgentConfig {
  feishuClient: FeishuClient;
  model?: string;
  // 新增配置
  compactThreshold?: number;  // 触发压缩的文件大小阈值
  timeout?: number;           // 单次请求超时时间
  maxRetries?: number;        // 最大重试次数
  retryDelay?: number;        // 重试延迟基数（指数退避）
  autoCompact?: boolean;      // 是否自动压缩（默认 false，通知用户手动处理）
  // 队列配置
  maxQueueSize?: number;      // 队列最大容量
  queueFullBehavior?: QueueFullBehavior; // 队列满时的行为
}

// 会话健康状态
export type SessionHealth = 'healthy' | 'needs_compact' | 'corrupted' | 'not_found';

export class ClaudeNativeAgent {
  private feishuClient: FeishuClient;
  private model: string;
  private isProcessing: boolean = false;

  // 新增配置
  private compactThreshold: number;
  private timeout: number;
  private maxRetries: number;
  private retryDelay: number;
  private autoCompact: boolean;

  // 统计信息
  private compactionCount: number = 0;
  private totalTokensUsed: number = 0;
  private totalCost: number = 0;
  private lastCompactTime: Date | null = null;

  // 消息队列
  private messageQueue: QueuedMessage[] = [];
  private queueProcessing: boolean = false;
  private maxQueueRetries: number = 3;
  private maxQueueSize: number;
  private queueFullBehavior: QueueFullBehavior;
  private defaultChatId: string = '';  // 默认飞书聊天 ID，用于 Worker 通知
  private queueDropCount: number = 0;  // 队列丢弃计数（监控用）

  // 记忆压缩（P1）
  private storage: SQLiteStorage;

  constructor(config: ClaudeNativeAgentConfig) {
    this.feishuClient = config.feishuClient;
    this.model = config.model || getDefaultModel();

    // 配置初始化
    this.compactThreshold = config.compactThreshold || DEFAULT_COMPACT_THRESHOLD;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
    this.retryDelay = config.retryDelay || DEFAULT_RETRY_DELAY;
    this.autoCompact = config.autoCompact ?? false;

    // 队列配置
    this.maxQueueSize = config.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.queueFullBehavior = config.queueFullBehavior || 'drop_oldest'; // 默认丢弃最旧消息

    // 初始化存储（用于记忆压缩）
    this.storage = new SQLiteStorage(PATHS.DB_PATH);
  }

  /**
   * 统一的消息入队方法
   * @returns 入队结果，包含是否成功、当前队列长度、被丢弃的消息（如果有）
   */
  private enqueueMessage(msg: QueuedMessage): EnqueueResult {
    const currentLength = this.messageQueue.length;

    // 队列未满，直接入队
    if (currentLength < this.maxQueueSize) {
      this.messageQueue.push(msg);
      return {
        success: true,
        queueLength: this.messageQueue.length,
      };
    }

    // 队列已满，根据策略处理
    let droppedMessage: QueuedMessage | undefined;

    switch (this.queueFullBehavior) {
      case 'reject':
        // 拒绝新消息
        logger.warn(`消息队列已满 (${currentLength}/${this.maxQueueSize})，拒绝新消息: ${msg.id}`);
        return {
          success: false,
          queueLength: currentLength,
          error: '队列已满，请稍后重试',
        };

      case 'drop_newest':
        // 丢弃新消息
        logger.warn(`消息队列已满 (${currentLength}/${this.maxQueueSize})，丢弃新消息: ${msg.id}`);
        this.queueDropCount++;
        return {
          success: false,
          queueLength: currentLength,
          droppedMessage: msg,
          error: '队列已满，消息被丢弃',
        };

      case 'drop_oldest':
      default:
        // 丢弃最旧的消息
        droppedMessage = this.messageQueue.shift();
        this.messageQueue.push(msg);
        this.queueDropCount++;
        logger.warn(`消息队列已满 (${currentLength}/${this.maxQueueSize})，丢弃最旧消息: ${droppedMessage?.id}`);
        return {
          success: true,
          queueLength: this.messageQueue.length,
          droppedMessage,
        };
    }
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): QueueStatusInfo {
    const oldestMsg = this.messageQueue[0];
    const now = Date.now();

    return {
      length: this.messageQueue.length,
      maxSize: this.maxQueueSize,
      isProcessing: this.queueProcessing,
      utilizationPercent: Math.round((this.messageQueue.length / this.maxQueueSize) * 100),
      oldestMessageAge: oldestMsg ? now - oldestMsg.timestamp.getTime() : undefined,
    };
  }

  /**
   * 获取队列丢弃计数（监控用）
   */
  getQueueDropCount(): number {
    return this.queueDropCount;
  }

  /**
   * 重置队列丢弃计数
   */
  resetQueueDropCount(): void {
    this.queueDropCount = 0;
  }

  /**
   * 启动 Agent
   * - 创建独立工作目录
   * - 写入系统提示词
   */
  async start(): Promise<void> {
    logger.info('Claude Native Agent 启动中...');

    // 创建小智配置目录和独立工作目录
    await fs.mkdir(PATHS.XIAOZHI_HOME, { recursive: true });
    await fs.mkdir(PATHS.WORKSPACE, { recursive: true });

    // 写入系统提示词到工作目录
    await this.writeSystemPrompt();

    logger.info(`工作目录: ${PATHS.WORKSPACE}`);
    logger.info('Claude Native Agent 已就绪');
  }

  /**
   * 停止 Agent
   * 会话由 Claude CLI 自动保存，无需额外操作
   */
  async stop(): Promise<void> {
    logger.info('Claude Native Agent 已停止（会话已由 Claude CLI 自动保存）');
  }

  /**
   * 设置默认飞书聊天 ID（用于 Worker 通知）
   */
  setDefaultChatId(chatId: string): void {
    this.defaultChatId = chatId;
  }

  /**
   * 处理飞书消息（入队）
   */
  async handleMessage(msg: FeishuMessage): Promise<void> {
    // 保存 chatId 用于 Worker 通知
    if (msg.chatId) {
      this.defaultChatId = msg.chatId;
    }

    // 检查特殊命令（优先处理，不入队）
    const trimmedContent = msg.content.trim();
    if (trimmedContent === '/compact' || trimmedContent === '/压缩') {
      await this.handleCompactCommand(msg);
      return;
    }
    if (trimmedContent === '/stats' || trimmedContent === '/统计') {
      await this.handleStatsCommand(msg);
      return;
    }
    if (trimmedContent === '/health' || trimmedContent === '/健康') {
      await this.handleHealthCommand(msg);
      return;
    }
    if (trimmedContent === '/reset' || trimmedContent === '/重置') {
      await this.handleResetCommand(msg);
      return;
    }

    // 入队处理
    const queueMsg: QueuedMessage = {
      id: `feishu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'feishu',
      content: msg.content,
      chatId: msg.chatId,
      timestamp: new Date(),
      retries: 0,
    };

    // 使用统一的入队方法
    const enqueueResult = this.enqueueMessage(queueMsg);

    if (!enqueueResult.success) {
      // 入队失败，通知用户
      logger.warn(`飞书消息入队失败: ${queueMsg.id}, 原因: ${enqueueResult.error}`);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: `❌ ${enqueueResult.error || '系统繁忙，请稍后重试'}`,
        type: 'text',
      }).catch(() => {});
      return;
    }

    // 如果有被丢弃的消息，通知对应的用户
    if (enqueueResult.droppedMessage?.chatId) {
      await this.feishuClient.sendMessage(enqueueResult.droppedMessage.chatId, {
        content: '⚠️ 消息处理超时，已被丢弃。请重新发送。',
        type: 'text',
      }).catch(() => {});
    }

    logger.info(`飞书消息入队: ${queueMsg.id}, 队列长度: ${enqueueResult.queueLength}`);

    // 如果正在处理，通知用户
    if (this.isProcessing) {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '⏳ 消息已入队，正在处理上一个请求...',
        type: 'text',
      }).catch(() => {});
    }

    // 触发队列处理
    this.processQueue();
  }

  /**
   * 处理 Worker 消息（入队）
   */
  async handleWorkerMessage(data: {
    workerId: string;
    workerName: string;
    taskName: string;
    status: 'completed' | 'failed';
    result: string;
    cost?: number;
    duration?: number;
  }): Promise<void> {
    // 构建 Worker 通知消息
    const content = [
      `[Worker:${data.taskName}]`,
      `Worker ID: ${data.workerId}`,
      `Worker 名称: ${data.workerName}`,
      `状态: ${data.status === 'completed' ? '已完成' : '失败'}`,
      data.duration ? `耗时: ${Math.round(data.duration / 1000)}秒` : '',
      data.cost ? `成本: $${data.cost.toFixed(4)}` : '',
      '',
      '结果:',
      data.result,
    ].filter(Boolean).join('\n');

    const queueMsg: QueuedMessage = {
      id: `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'worker',
      content,
      workerId: data.workerId,
      workerName: data.workerName,
      taskName: data.taskName,
      status: data.status,
      cost: data.cost,
      duration: data.duration,
      timestamp: new Date(),
      retries: 0,
    };

    // 使用统一的入队方法
    const enqueueResult = this.enqueueMessage(queueMsg);

    if (!enqueueResult.success) {
      logger.warn(`Worker消息入队失败: ${queueMsg.id}, 原因: ${enqueueResult.error}`);
      // Worker 消息入队失败，记录日志但不阻塞
      return;
    }

    logger.info(`Worker消息入队: ${queueMsg.id} (${data.taskName}), 队列长度: ${enqueueResult.queueLength}`);

    // 触发队列处理
    this.processQueue();
  }

  /**
   * 处理专家消息（入队）
   */
  async handleExpertMessage(data: {
    expertName: string;
    success: boolean;
    result: string;
    task: string;
  }): Promise<void> {
    // 构建专家通知消息
    const content = [
      `[专家:${data.expertName}]`,
      `状态: ${data.success ? '已完成' : '失败'}`,
      data.task ? `任务: ${data.task}` : '',
      '',
      '结果:',
      data.result,
    ].filter(Boolean).join('\n');

    const queueMsg: QueuedMessage = {
      id: `expert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: 'expert',
      content,
      expertName: data.expertName,
      expertSuccess: data.success,
      timestamp: new Date(),
      retries: 0,
    };

    // 使用统一的入队方法
    const enqueueResult = this.enqueueMessage(queueMsg);

    if (!enqueueResult.success) {
      logger.warn(`专家消息入队失败: ${queueMsg.id}, 原因: ${enqueueResult.error}`);
      // 专家消息入队失败，记录日志但不阻塞
      return;
    }

    logger.info(`专家消息入队: ${queueMsg.id} (${data.expertName}), 队列长度: ${enqueueResult.queueLength}`);

    // 触发队列处理
    this.processQueue();
  }

  /**
   * 处理消息队列
   */
  private async processQueue(): Promise<void> {
    if (this.queueProcessing || this.messageQueue.length === 0) {
      return;
    }

    this.queueProcessing = true;

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue[0];

      try {
        await this.processMessage(msg);
        // 处理成功，出队
        this.messageQueue.shift();
        logger.info(`消息处理完成: ${msg.id}, 剩余队列: ${this.messageQueue.length}`);
      } catch (error) {
        logger.error(`消息处理失败: ${msg.id}`, error);
        msg.retries++;

        if (msg.retries >= this.maxQueueRetries) {
          // 超过重试次数，出队并通知
          this.messageQueue.shift();
          logger.error(`消息超过重试次数，丢弃: ${msg.id}`);
          if (msg.chatId) {
            await this.feishuClient.sendMessage(msg.chatId, {
              content: `消息处理失败，已丢弃。请稍后重试。`,
              type: 'text',
            }).catch(() => {});
          }
        } else {
          // 保留在队列中，等待下次处理
          // 先出队再入队（放到队尾）
          this.messageQueue.shift();
          this.messageQueue.push(msg);
          logger.warn(`消息将重试: ${msg.id}, 重试次数: ${msg.retries}`);
          // 等待一段时间再继续
          await this.sleep(2000);
        }
      }
    }

    this.queueProcessing = false;
  }

  /**
   * 处理单条消息
   */
  private async processMessage(msg: QueuedMessage): Promise<void> {
    if (this.isProcessing) {
      throw new Error('Another message is being processed');
    }

    this.isProcessing = true;
    const startTime = Date.now();

    // 超时自动重置保护（5分钟）
    const safetyTimer = setTimeout(() => {
      if (this.isProcessing) {
        logger.warn('isProcessing 超时自动重置');
        this.isProcessing = false;
      }
    }, 5 * 60 * 1000);

    // 进度提示（仅飞书消息）
    let progressSent = false;
    const progressTimer = msg.source === 'feishu' ? setTimeout(async () => {
      if (!progressSent && msg.chatId) {
        progressSent = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        await this.feishuClient.sendMessage(msg.chatId!, {
          content: `⏳ 思考中... (${elapsed}s)`,
          type: 'text',
        }).catch(() => {});
      }
    }, 8000) : null;

    try {
      // 添加来源前缀
      const prefixedContent = msg.source === 'feishu'
        ? `[主人@飞书] ${msg.content}`
        : msg.content;

      logger.info(`处理消息: ${msg.id}, 来源: ${msg.source}`);

      // 检查是否需要压缩提示（仅飞书消息）
      if (msg.source === 'feishu' && msg.chatId) {
        const stats = await this.getSessionStats();
        if (stats.needsCompaction && !this.autoCompact) {
          this.feishuClient.sendMessage(msg.chatId, {
            content: `💡 会话上下文较大 (${this.formatBytes(stats.fileSize)})，建议发送 /compact 压缩历史`,
            type: 'text',
          }).catch(() => {});
        }
      }

      // 调用 Claude
      const response = await this.callClaudeWithRetry(prefixedContent);

      if (progressTimer) clearTimeout(progressTimer);

      const elapsed = Date.now() - startTime;
      logger.info(`响应完成，耗时: ${elapsed}ms`);

      // 发送回复
      const targetChatId = msg.chatId || this.defaultChatId;
      if (targetChatId) {
        await this.feishuClient.sendMessage(targetChatId, {
          content: response,
          type: 'text',
        });
        logger.info(`已发送回复到飞书 (chatId: ${targetChatId.slice(0, 10)}...)`);
      }

    } catch (error) {
      logger.error('处理失败:', error);
      if (progressTimer) clearTimeout(progressTimer);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const shortError = errorMessage.slice(0, 200);

      const targetChatId = msg.chatId || this.defaultChatId;
      if (targetChatId) {
        try {
          await this.feishuClient.sendMessage(targetChatId, {
            content: `处理出错: ${shortError}\n\n请稍后重试，或发送 /health 检查状态。`,
            type: 'text',
          });
        } catch (sendError) {
          logger.error('发送错误消息失败:', sendError);
        }
      }

      throw error;
    } finally {
      clearTimeout(safetyTimer);
      this.isProcessing = false;
    }
  }

  /**
   * 发送飞书通知（用于升级等场景）
   */
  async sendFeishuNotification(message: string): Promise<void> {
    if (!this.defaultChatId) {
      logger.warn('没有默认 chatId，无法发送飞书通知');
      return;
    }

    try {
      await this.feishuClient.sendMessage(this.defaultChatId, {
        content: message,
        type: 'text',
      });
      logger.info('飞书通知已发送');
    } catch (error) {
      logger.error('发送飞书通知失败:', error);
    }
  }

  /**
   * 处理测试消息（给影子实例用）
   * 直接处理消息并返回响应，不经过队列
   */
  async processTestMessage(content: string): Promise<string> {
    logger.info(`处理测试消息: ${content.slice(0, 50)}...`);

    try {
      // 直接调用 Claude
      const response = await this.callClaudeWithRetry(`[测试消息] ${content}`);
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('处理测试消息失败:', error);
      return `处理失败: ${errorMessage}`;
    }
  }

  /**
   * 处理 /compact 命令
   */
  private async handleCompactCommand(msg: FeishuMessage): Promise<void> {
    try {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '🔄 正在压缩会话上下文...',
        type: 'text',
      });

      const result = await this.executeCompact();

      await this.feishuClient.sendMessage(msg.chatId, {
        content: result,
        type: 'text',
      });
    } catch (error) {
      logger.error('压缩失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '压缩失败，请稍后重试。',
        type: 'text',
      });
    }
  }

  /**
   * 处理 /stats 命令
   */
  private async handleStatsCommand(msg: FeishuMessage): Promise<void> {
    try {
      const stats = await this.getSessionStats();
      const health = await this.checkSessionHealth();

      const healthEmoji = {
        'healthy': '✅',
        'needs_compact': '⚠️',
        'corrupted': '❌',
        'not_found': '❓',
      };

      const response = [
        `📊 **会话统计**`,
        ``,
        `状态: ${healthEmoji[health]} ${health}`,
        `会话文件: ${stats.fileSize > 0 ? this.formatBytes(stats.fileSize) : '不存在'}`,
        `消息数量: ${stats.messageCount}`,
        `总成本: $${stats.totalCost.toFixed(4)}`,
        `压缩次数: ${stats.compactionCount}`,
        ``,
        `压缩阈值: ${this.formatBytes(this.compactThreshold)}`,
        `需要压缩: ${stats.needsCompaction ? '是' : '否'}`,
      ].join('\n');

      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });
    } catch (error) {
      logger.error('获取统计失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '获取统计失败。',
        type: 'text',
      });
    }
  }

  /**
   * 处理 /health 命令
   */
  private async handleHealthCommand(msg: FeishuMessage): Promise<void> {
    try {
      const health = await this.checkSessionHealth();
      const stats = await this.getSessionStats();

      let response = `健康检查结果: ${health}\n\n`;

      switch (health) {
        case 'healthy':
          response += '✅ 会话正常，可以继续使用。';
          break;
        case 'needs_compact':
          response += `⚠️ 会话上下文较大 (${this.formatBytes(stats.fileSize)})，建议执行 /compact 压缩。`;
          break;
        case 'corrupted':
          response += '❌ 会话可能已损坏，建议执行 /reset 重建会话。';
          break;
        case 'not_found':
          response += '❓ 未找到会话文件，将在下次对话时自动创建。';
          break;
      }

      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });
    } catch (error) {
      logger.error('健康检查失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '健康检查失败。',
        type: 'text',
      });
    }
  }

  /**
   * 处理 /reset 命令
   */
  private async handleResetCommand(msg: FeishuMessage): Promise<void> {
    try {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '🔄 正在重置会话...',
        type: 'text',
      });

      // 归档工作目录中的会话文件
      await this.archiveSession();

      // 重置统计
      this.compactionCount = 0;
      this.totalTokensUsed = 0;
      this.totalCost = 0;

      await this.feishuClient.sendMessage(msg.chatId, {
        content: '✅ 会话已重置，历史对话已归档。可以开始新的对话了。',
        type: 'text',
      });
    } catch (error) {
      logger.error('重置失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '重置失败，请稍后重试。',
        type: 'text',
      });
    }
  }

  /**
   * 调用 Claude CLI（带重试机制）
   */
  private async callClaudeWithRetry(userMessage: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.callClaude(userMessage);
      } catch (error) {
        lastError = error as Error;
        logger.warn(`调用失败 (尝试 ${attempt}/${this.maxRetries}):`, error);

        // 检查是否为不可恢复错误
        if (!this.isRecoverableError(lastError)) {
          logger.error('不可恢复错误，放弃重试:', lastError.message);
          throw lastError;
        }

        // 如果是超时错误，检查是否有部分响应可以恢复
        if (lastError.message === 'Timeout' && attempt < this.maxRetries) {
          // 指数退避
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.info(`等待 ${delay}ms 后重试...`);
          await this.sleep(delay);
          continue;
        }

        // 如果是会话损坏，尝试恢复
        if (lastError.message.includes('session') || lastError.message.includes('corrupt')) {
          logger.info('检测到会话问题，尝试恢复...');
          await this.recoverSession();

          if (attempt < this.maxRetries) {
            const delay = this.retryDelay * Math.pow(2, attempt - 1);
            await this.sleep(delay);
            continue;
          }
        }

        // 其他可恢复错误直接重试
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retries failed');
  }

  /**
   * 判断错误是否可恢复（可重试）
   */
  private isRecoverableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // 不可恢复错误关键词
    const unrecoverablePatterns = [
      'authentication', 'auth failed', 'credentials', 'invalid api key',
      'permission denied', 'access denied', 'forbidden',
      'invalid config', 'configuration error',
      'not found', '404',
      'rate limit', 'quota exceeded',  // 这些需要等待，暂时也算不可恢复
      'billing', 'payment required', 'insufficient funds',
    ];

    for (const pattern of unrecoverablePatterns) {
      if (message.includes(pattern)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 调用 Claude CLI
   * 使用独立工作目录 + --continue 实现会话持久化
   * 使用 --dangerously-skip-permissions 获得完整系统权限
   */
  private async callClaude(userMessage: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--verbose',
        '--continue',  // 继续最近的会话
        '--output-format', 'stream-json',
        '--model', this.model,
        '--dangerously-skip-permissions',  // 跳过权限检查，允许完整系统访问
        '--add-dir', '/home/wxy',  // 添加 /home/wxy 目录访问权限
      ];

      logger.info(`调用 Claude (--continue, 工作目录: ${PATHS.WORKSPACE})`);
      logger.debug(`消息内容: ${userMessage.slice(0, 100)}...`);

      const proc = spawn('claude', args, {
        cwd: PATHS.WORKSPACE,  // 使用独立工作目录
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 通过 stdin 传递消息
      proc.stdin?.write(userMessage);
      proc.stdin?.end();

      let responseText = '';
      let errorOutput = '';
      let isComplete = false;
      let lastCost = 0;
      let lastTokens = 0;

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk: ResponseChunk = JSON.parse(line);

            if (chunk.type === 'assistant' && chunk.message?.content) {
              // 从 assistant 消息中提取文本
              for (const content of chunk.message.content) {
                if (content.type === 'text' && content.text) {
                  responseText = content.text; // 使用最后一个 assistant 消息
                }
              }
            } else if (chunk.type === 'result') {
              isComplete = true;
              // result 中也包含最终文本，优先使用
              if (chunk.result) {
                responseText = chunk.result;
              }
              lastCost = chunk.total_cost_usd || 0;
              lastTokens = chunk.usage?.output_tokens || 0;
              this.totalCost += lastCost;
              this.totalTokensUsed += lastTokens;
              logger.info(`Claude 完成，成本: $${lastCost.toFixed(4)}，tokens: ${lastTokens}`);
            } else if (chunk.type === 'error' || chunk.is_error) {
              logger.error(`Claude 错误: ${chunk.content || chunk.result}`);
              errorOutput += chunk.content || chunk.result || '';
            }
            // 忽略 type: "system" 的初始化消息
          } catch {
            // 非 JSON 行，可能是普通文本输出
            responseText += line;
          }
        }
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
        if (errorOutput.includes('Error') || errorOutput.includes('error')) {
          logger.error(`Claude stderr: ${errorOutput.slice(0, 200)}`);
        }
      });

      proc.on('close', (code) => {
        if (code !== 0 && !responseText) {
          reject(new Error(`Claude failed: ${errorOutput}`));
        } else {
          resolve(responseText.trim());
        }
      });

      proc.on('error', reject);

      // 超时处理
      setTimeout(async () => {
        if (!isComplete) {
          logger.warn(`Claude 调用超时 (${this.timeout}ms)，正在终止进程...`);

          // 使用进程树杀死，确保所有子进程都被终止
          await this.killProcessTree(proc);

          if (responseText) {
            logger.warn('超时但有部分响应，返回部分内容');
            resolve(responseText.trim());
          } else {
            reject(new Error('Timeout'));
          }
        }
      }, this.timeout);
    });
  }

  /**
   * 安全终止进程及其子进程
   * 使用 SIGTERM -> 等待 -> SIGKILL 的优雅关闭流程
   */
  private async killProcessTree(proc: ReturnType<typeof spawn>): Promise<void> {
    const pid = proc.pid;
    if (!pid) return;

    try {
      // 1. 尝试使用 pkill 杀死进程组（包括所有子进程）
      // 使用 PGID 来杀死整个进程组
      const { execSync } = await import('child_process');

      try {
        // 发送 SIGTERM 到整个进程组
        process.kill(-pid, 'SIGTERM');
        logger.debug(`发送 SIGTERM 到进程组 ${pid}`);
      } catch {
        // 如果进程组杀失败，尝试单独杀死进程
        proc.kill('SIGTERM');
        logger.debug(`发送 SIGTERM 到进程 ${pid}`);
      }

      // 2. 等待进程退出（最多 3 秒）
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          // 检查进程是否还存在
          process.kill(pid, 0);
          await this.sleep(100);
        } catch {
          // 进程已退出
          logger.debug(`进程 ${pid} 已退出`);
          return;
        }
      }

      // 3. 进程未在 3 秒内退出，强制杀死
      logger.warn(`进程 ${pid} 未响应 SIGTERM，使用 SIGKILL 强制终止`);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }

      // 等待进程退出
      await this.sleep(500);
    } catch (error) {
      logger.error('终止进程时出错:', error);
      // 最后手段：直接杀死
      try {
        proc.kill('SIGKILL');
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 执行会话压缩
   */
  async executeCompact(): Promise<string> {
    const projectDir = this.getProjectSessionDir();

    // 检查是否有会话文件
    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return '会话文件不存在，无需压缩。';
      }

      // 计算总大小
      let totalSize = 0;
      for (const f of sessionFiles) {
        const stats = await fs.stat(path.join(projectDir, f));
        totalSize += stats.size;
      }

      if (totalSize < 1024 * 100) { // 小于100KB不压缩
        return `会话文件较小 (${this.formatBytes(totalSize)})，无需压缩。`;
      }

      // P1: 压缩前提取记忆
      try {
        let sessionContent = '';
        for (const f of sessionFiles) {
          const content = await fs.readFile(path.join(projectDir, f), 'utf-8');
          sessionContent += content + '\n';
        }
        await this.compressSession(sessionContent);
      } catch (error) {
        logger.warn('记忆提取失败，继续压缩:', error);
      }

      // 归档所有会话
      await this.archiveSession();
      this.compactionCount++;
      this.lastCompactTime = new Date();

      // P1: 重新注入记忆到系统提示词
      await this.writeSystemPrompt();

      return `✅ 会话已重置\n- 原大小: ${this.formatBytes(totalSize)}\n- 历史已归档到 backups/ 目录`;
    } catch {
      return '会话文件不存在，无需压缩。';
    }
  }

  /**
   * 归档会话文件
   * 查找工作目录对应的所有会话文件并归档
   * 使用文件锁防止并发冲突
   */
  private async archiveSession(): Promise<void> {
    await this.withLock('session-archive', async () => {
      const projectDir = this.getProjectSessionDir();
      const backupsDir = path.join(projectDir, 'backups');

      try {
        // 确保项目会话目录存在
        await fs.mkdir(projectDir, { recursive: true });

        // 获取所有会话文件
        const files = await fs.readdir(projectDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

        if (sessionFiles.length === 0) {
          logger.info('没有会话文件需要归档');
          return;
        }

        // 确保备份目录存在
        await fs.mkdir(backupsDir, { recursive: true });

        // 生成备份时间戳
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        // 归档所有会话文件
        for (const sessionFile of sessionFiles) {
          const sourcePath = path.join(projectDir, sessionFile);
          const backupFile = path.join(backupsDir, `${sessionFile.replace('.jsonl', '')}-${timestamp}.jsonl`);

          await fs.copyFile(sourcePath, backupFile);
          await fs.unlink(sourcePath);

          logger.info(`会话已归档: ${backupFile}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        // 目录不存在，无需处理
        logger.info('会话目录不存在，无需归档');
      }
    });
  }

  /**
   * 恢复损坏的会话
   * 从最近的备份恢复
   * 使用文件锁防止并发冲突
   */
  private async recoverSession(): Promise<void> {
    await this.withLock('session-archive', async () => {
      const projectDir = this.getProjectSessionDir();
      const backupsDir = path.join(projectDir, 'backups');

      try {
        // 获取所有会话文件
        const files = await fs.readdir(projectDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

        // 如果没有会话文件，尝试从备份恢复
        if (sessionFiles.length === 0) {
          const backupFiles = await fs.readdir(backupsDir);
          const sortedBackups = backupFiles.filter(f => f.endsWith('.jsonl')).sort().reverse();

          if (sortedBackups.length > 0) {
            // 恢复最近的备份（去掉时间戳后缀）
            const latestBackup = sortedBackups[0];
            const originalName = latestBackup.replace(/-\d{4}-\d{2}-\d{2}T.*/, '.jsonl');
            await fs.copyFile(
              path.join(backupsDir, latestBackup),
              path.join(projectDir, originalName)
            );
            logger.info(`从备份恢复会话: ${latestBackup}`);
            return;
          }
        }

        // 没有备份，删除损坏的文件
        logger.warn('没有找到备份，删除损坏的会话文件');
        for (const sessionFile of sessionFiles) {
          await fs.unlink(path.join(projectDir, sessionFile)).catch(() => {});
        }
      } catch (error) {
        logger.error('恢复会话失败:', error);
        // 最后手段：删除所有损坏文件
        try {
          const files = await fs.readdir(projectDir);
          for (const f of files.filter(f => f.endsWith('.jsonl'))) {
            await fs.unlink(path.join(projectDir, f)).catch(() => {});
          }
        } catch {}
      }
    });
  }

  /**
   * 检查会话健康状态
   */
  async checkSessionHealth(): Promise<SessionHealth> {
    const projectDir = this.getProjectSessionDir();

    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return 'not_found';
      }

      // 检查最新的会话文件（按修改时间排序）
      let latestFile: string | null = null;
      let latestTime = 0;

      for (const f of sessionFiles) {
        const filePath = path.join(projectDir, f);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return 'not_found';
      }

      const stats = await fs.stat(latestFile);

      // 检查是否需要压缩
      if (stats.size > this.compactThreshold) {
        return 'needs_compact';
      }

      // 检查文件是否可读（简单验证）
      const content = await fs.readFile(latestFile, 'utf-8');
      if (content.length === 0) {
        return 'corrupted';
      }

      // 尝试解析几行验证格式
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > 0) {
        try {
          JSON.parse(lines[lines.length - 1]);
        } catch {
          return 'corrupted';
        }
      }

      return 'healthy';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'not_found';
      }
      return 'corrupted';
    }
  }

  /**
   * 获取会话统计信息
   */
  async getSessionStats(): Promise<SessionStats> {
    const projectDir = this.getProjectSessionDir();

    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return {
          sessionFile: projectDir,
          fileSize: 0,
          messageCount: 0,
          createdAt: null,
          lastModified: null,
          needsCompaction: false,
          compactionCount: this.compactionCount,
          totalTokensUsed: this.totalTokensUsed,
          totalCost: this.totalCost,
        };
      }

      // 获取最新的会话文件
      let latestFile: string | null = null;
      let latestTime = 0;
      let totalSize = 0;

      for (const f of sessionFiles) {
        const filePath = path.join(projectDir, f);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return {
          sessionFile: projectDir,
          fileSize: 0,
          messageCount: 0,
          createdAt: null,
          lastModified: null,
          needsCompaction: false,
          compactionCount: this.compactionCount,
          totalTokensUsed: this.totalTokensUsed,
          totalCost: this.totalCost,
        };
      }

      const stats = await fs.stat(latestFile);
      const content = await fs.readFile(latestFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      return {
        sessionFile: latestFile,
        fileSize: stats.size,
        messageCount: lines.length,
        createdAt: stats.birthtime,
        lastModified: stats.mtime,
        needsCompaction: stats.size > this.compactThreshold,
        compactionCount: this.compactionCount,
        totalTokensUsed: this.totalTokensUsed,
        totalCost: this.totalCost,
      };
    } catch {
      return {
        sessionFile: projectDir,
        fileSize: 0,
        messageCount: 0,
        createdAt: null,
        lastModified: null,
        needsCompaction: false,
        compactionCount: this.compactionCount,
        totalTokensUsed: this.totalTokensUsed,
        totalCost: this.totalCost,
      };
    }
  }

  /**
   * 获取项目会话目录路径
   * Claude CLI 使用项目路径的哈希来组织会话
   */
  private getProjectSessionDir(): string {
    // Claude CLI 生成项目哈希的方式：基于工作目录路径
    // 格式: ~/.claude/projects/<project-hash>/
    // 使用简单的方式生成项目哈希（与 Claude CLI 行为一致）
    const projectHash = this.generateProjectHash(PATHS.WORKSPACE);
    return path.join(os.homedir(), '.claude', 'projects', projectHash);
  }

  /**
   * 生成项目哈希
   * Claude CLI 使用路径转换作为项目哈希（将 / 和 . 都替换为 -）
   * 例如: /home/wxy/.xiaozhi/workspace -> -home-wxy--xiaozhi-workspace
   */
  private generateProjectHash(projectPath: string): string {
    // Claude CLI 的项目哈希是将 / 和 . 都替换为 -
    return projectPath.replace(/\//g, '-').replace(/\./g, '-');
  }

  /**
   * 获取最新的会话文件路径
   * 使用 --continue 时，Claude CLI 会选择最近的会话
   */
  private getSessionFilePath(): string {
    // 返回项目会话目录（用于检查和归档）
    // 实际会话文件由 Claude CLI 自动管理
    const projectDir = this.getProjectSessionDir();
    return path.join(projectDir, 'latest.jsonl');
  }

  /**
   * 获取项目会话目录中的所有会话文件
   */
  private async getSessionFiles(): Promise<string[]> {
    const projectDir = this.getProjectSessionDir();
    try {
      const files = await fs.readdir(projectDir);
      return files.filter(f => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
  }

  /**
   * 写入系统提示词到用户主目录
   * Claude CLI 会读取 CLAUDE.md 作为项目说明
   */
  /**
   * 写入系统提示词到工作目录
   * Claude CLI 会读取当前目录的 CLAUDE.md 作为项目说明
   */
  private async writeSystemPrompt(): Promise<void> {
    const claudeMdPath = path.join(PATHS.WORKSPACE, 'CLAUDE.md');

    // 检查是否有自定义系统提示词文件
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const customPrompt = await fs.readFile(PATHS.SYSTEM_PROMPT_FILE, 'utf-8');
      systemPrompt = customPrompt;
      logger.info('使用自定义系统提示词');
    } catch {
      // 使用默认提示词
    }

    // P1: 注入记忆
    const memoryContext = this.injectMemories();
    if (memoryContext) {
      systemPrompt += memoryContext;
      logger.info('已注入长期记忆到系统提示词');
    }

    await fs.writeFile(claudeMdPath, systemPrompt);
    logger.info(`系统提示词已写入 ${claudeMdPath}`);
  }

  /**
   * 检查会话是否已存在
   */
  private async checkSessionExists(): Promise<boolean> {
    const sessionFiles = await this.getSessionFiles();
    return sessionFiles.length > 0;
  }

  /**
   * 获取会话历史（调试用）
   */
  async getSessionHistory(): Promise<string[]> {
    const projectDir = this.getProjectSessionDir();

    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return [];
      }

      // 获取最新的会话文件
      let latestFile: string | null = null;
      let latestTime = 0;

      for (const f of sessionFiles) {
        const filePath = path.join(projectDir, f);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return [];
      }

      const content = await fs.readFile(latestFile, 'utf-8');
      return content.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  /**
   * 辅助函数：sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== 文件锁机制 ====================

  /**
   * 获取锁文件路径
   */
  private getLockFilePath(lockName: string): string {
    return path.join(PATHS.LOCKS_DIR, `${lockName}.lock`);
  }

  /**
   * 获取文件锁
   * @param lockName 锁名称
   * @param timeout 超时时间（毫秒）
   * @returns 锁释放函数
   */
  private async acquireLock(lockName: string, timeout: number = DEFAULT_LOCK_TIMEOUT): Promise<() => Promise<void>> {
    const lockFile = this.getLockFilePath(lockName);
    await fs.mkdir(PATHS.LOCKS_DIR, { recursive: true });

    const startTime = Date.now();
    const lockId = `${process.pid}-${Date.now()}`;

    while (true) {
      try {
        // 尝试创建锁文件（独占模式）
        const existingLock = await fs.readFile(lockFile, 'utf-8').catch(() => null);

        if (existingLock) {
          // 检查锁是否过期
          const lockData = JSON.parse(existingLock);
          if (Date.now() - lockData.timestamp > timeout) {
            // 锁已过期，删除旧锁
            logger.warn(`锁已过期，删除旧锁: ${lockName}`);
            await fs.unlink(lockFile).catch(() => {});
          } else {
            // 锁仍有效，等待
            if (Date.now() - startTime > timeout) {
              throw new Error(`获取锁超时: ${lockName}`);
            }
            await this.sleep(100);
            continue;
          }
        }

        // 创建新锁
        await fs.writeFile(lockFile, JSON.stringify({
          lockId,
          pid: process.pid,
          timestamp: Date.now(),
        }), { flag: 'wx' }); // wx = 独占创建

        logger.debug(`获取锁成功: ${lockName} (${lockId})`);

        // 返回释放函数
        return async () => {
          try {
            const currentLock = await fs.readFile(lockFile, 'utf-8');
            const data = JSON.parse(currentLock);
            if (data.lockId === lockId) {
              await fs.unlink(lockFile);
              logger.debug(`释放锁成功: ${lockName}`);
            }
          } catch {
            // 锁文件可能已被删除
          }
        };
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // 文件已存在，继续等待
          if (Date.now() - startTime > timeout) {
            throw new Error(`获取锁超时: ${lockName}`);
          }
          await this.sleep(100);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * 使用锁执行操作
   * @param lockName 锁名称
   * @param operation 要执行的操作
   */
  private async withLock<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    const releaseLock = await this.acquireLock(lockName);
    try {
      return await operation();
    } finally {
      await releaseLock();
    }
  }

  // ==================== 记忆压缩系统（P1）====================

  /**
   * 记忆提取规则
   */
  private static MEMORY_RULES = {
    user_preference: {
      patterns: [
        { regex: /(?:我|用户)\s*(?:喜欢|偏好|习惯|想要|默认)(.+?)(?:[。，\n]|$)/g, weight: 1.0 },
        { regex: /(?:请|麻烦)(?:以后|之后|之后)(.+?)(?:[。，\n]|$)/g, weight: 0.8 },
        { regex: /(?:记住|记得)(.+?)(?:[。，\n]|$)/g, weight: 0.9 },
      ],
      minLength: 5,
      maxLength: 200,
      baseImportance: 2,
    },
    important_decision: {
      patterns: [
        { regex: /(?:决定|确认|选择|最终)(.+?)(?:[。，\n]|$)/g, weight: 1.0 },
        { regex: /(?:方案|策略)(\d+|[A-Z])(?:.*?)(?:是|为)(.+?)(?:[。，\n]|$)/g, weight: 0.9 },
        { regex: /(?:同意|批准|通过)(.+?)(?:[。，\n]|$)/g, weight: 0.8 },
      ],
      minLength: 10,
      maxLength: 300,
      baseImportance: 3,
    },
    unfinished_task: {
      patterns: [
        { regex: /(?:待办|需要|还要|还没|后续)(.+?)(?:[。，\n]|$)/g, weight: 0.9 },
        { regex: /(?:TODO|FIXME|XXX)[:：]\s*(.+?)(?:[。，\n]|$)/gi, weight: 1.0 },
        { regex: /(?:下次|之后|以后)(?:要|需要|记得)(.+?)(?:[。，\n]|$)/g, weight: 0.7 },
      ],
      minLength: 5,
      maxLength: 200,
      baseImportance: 2,
    },
    key_observation: {
      patterns: [
        { regex: /(?:发现|注意|观察到)(.+?)(?:[。，\n]|$)/g, weight: 0.8 },
        { regex: /(?:问题|错误|异常)[:：]\s*(.+?)(?:[。，\n]|$)/g, weight: 0.9 },
      ],
      minLength: 10,
      maxLength: 250,
      baseImportance: 2,
    },
  };

  /**
   * 计算记忆置信度
   */
  private calculateConfidence(value: string, weight: number, context: string): number {
    let confidence = weight;

    // 长度适中加分
    if (value.length >= 20 && value.length <= 100) {
      confidence += 0.1;
    }

    // 包含关键信息加分
    if (/[a-zA-Z0-9]/.test(value)) {
      confidence += 0.05; // 包含数字或英文
    }

    // 上下文相关性（简单检查）
    if (context.includes('小智') || context.includes('系统')) {
      confidence += 0.05;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * 检查两条记忆是否相似
   */
  private isSimilarMemory(a: string, b: string): boolean {
    // 完全相同
    if (a === b) return true;

    // 包含关系
    if (a.includes(b) || b.includes(a)) return true;

    // 简单的词汇重叠检查
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    // Jaccard 相似度 > 0.5 视为相似
    if (union.size > 0 && intersection.size / union.size > 0.5) {
      return true;
    }

    return false;
  }

  /**
   * 压缩会话并提取记忆
   * 在会话结束或压缩时调用，提取关键信息存入记忆库
   */
  private async compressSession(sessionContent: string): Promise<void> {
    try {
      const extractedMemories: Array<{
        type: string;
        value: string;
        confidence: number;
        importance: number;
      }> = [];

      // 按类型提取记忆
      for (const [type, rules] of Object.entries(ClaudeNativeAgent.MEMORY_RULES)) {
        for (const { regex, weight } of rules.patterns) {
          let match;
          const globalRegex = new RegExp(regex.source, regex.flags);

          while ((match = globalRegex.exec(sessionContent)) !== null) {
            const value = (match[1] || match[0]).trim();

            // 验证长度
            if (value.length < rules.minLength || value.length > rules.maxLength) {
              continue;
            }

            // 计算置信度
            const confidence = this.calculateConfidence(value, weight, sessionContent);

            // 只保留置信度 > 0.5 的记忆
            if (confidence > 0.5) {
              extractedMemories.push({
                type,
                value,
                confidence,
                importance: Math.round(rules.baseImportance * confidence),
              });
            }
          }
        }
      }

      // 去重：移除相似的记忆
      const uniqueMemories: typeof extractedMemories = [];
      for (const memory of extractedMemories) {
        const isDuplicate = uniqueMemories.some(
          existing =>
            existing.type === memory.type &&
            this.isSimilarMemory(existing.value, memory.value)
        );

        if (!isDuplicate) {
          uniqueMemories.push(memory);
        }
      }

      // 按置信度排序，只保留前 20 条
      uniqueMemories.sort((a, b) => b.confidence - a.confidence);
      const topMemories = uniqueMemories.slice(0, 20);

      // 保存记忆
      for (const memory of topMemories) {
        const hash = crypto.createHash('md5').update(memory.value).digest('hex').substring(0, 8);
        const id = `${memory.type}_${hash}`;

        this.storage.saveMemory({
          id,
          type: memory.type,
          key: `${memory.type}_${crypto.randomBytes(4).toString('hex')}`,
          value: memory.value,
          source: 'xiaozhi_session',
          importance: memory.importance,
        });
      }

      if (topMemories.length > 0) {
        logger.info(`记忆压缩完成: 提取 ${topMemories.length} 条记忆 (置信度平均: ${(topMemories.reduce((a, b) => a + b.confidence, 0) / topMemories.length).toFixed(2)})`);
      }
    } catch (error) {
      logger.error('记忆压缩失败:', error);
    }
  }

  /**
   * 注入记忆到上下文
   * 在新会话开始时调用，将重要记忆注入系统提示词
   */
  private injectMemories(): string {
    try {
      const importantMemories = this.storage.getImportantMemories(15);

      if (importantMemories.length === 0) {
        return '';
      }

      // 按类型分组
      const grouped: Record<string, string[]> = {};
      for (const memory of importantMemories) {
        if (!grouped[memory.type]) {
          grouped[memory.type] = [];
        }
        grouped[memory.type].push(`- ${memory.value}`);
      }

      // 构建记忆上下文
      const sections: string[] = ['\n## 长期记忆（来自历史会话）'];

      const typeNames: Record<string, string> = {
        user_preference: '用户偏好',
        important_decision: '重要决策',
        unfinished_task: '未完成任务',
        key_observation: '关键观察',
      };

      for (const [type, items] of Object.entries(grouped)) {
        const typeName = typeNames[type] || type;
        sections.push(`\n### ${typeName}`);
        sections.push(items.join('\n'));
      }

      return sections.join('\n');
    } catch (error) {
      logger.error('注入记忆失败:', error);
      return '';
    }
  }

  /**
   * 获取记忆统计
   */
  getMemoryStats(): { total: number; byType: Record<string, number> } {
    try {
      const stats = { total: 0, byType: {} as Record<string, number> };

      for (const type of Object.values(SQLiteStorage.MEMORY_TYPES)) {
        const memories = this.storage.getMemoriesByType(type);
        stats.byType[type] = memories.length;
        stats.total += memories.length;
      }

      return stats;
    } catch {
      return { total: 0, byType: {} };
    }
  }

  /**
   * 清理过期记忆
   */
  cleanupMemories(days: number = 90): number {
    return this.storage.cleanupOldMemories(days);
  }
}
