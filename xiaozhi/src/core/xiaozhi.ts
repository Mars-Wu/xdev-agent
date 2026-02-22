// src/core/xiaozhi.ts
// AI管家小智核心服务

import { spawn } from 'child_process';
import { FeishuClient } from '../feishu/client';
import { FeishuConfig } from '../feishu/types';
import { SessionManager } from '../session/manager';
import { WorkerManager } from '../worker/manager';
import { SQLiteStorage } from '../storage/sqlite';
import { ClaudeSession } from './claude-session';
import { FeishuMessage, FeishuReply } from '../feishu/types';
import { Message } from '../session/types';
import { WorkerSpawnConfig } from '../worker/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('xiaozhi');

export interface XiaoZhiConfig {
  model?: string;
  storage: {
    type: 'sqlite';
    path: string;
  };
  feishu: FeishuConfig;
  worker: {
    baseDir: string;
    scriptsDir: string;
    hooksPort: number;
  };
  usePersistentSession?: boolean; // 是否使用常驻会话
}

export class XiaoZhiService {
  private storage: SQLiteStorage;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager;
  private workerManager: WorkerManager;
  private claudeSession: ClaudeSession | null = null;
  private usePersistentSession: boolean;
  private model: string;
  private currentSessionId: string = '';

  public readonly workerManagerPublic: WorkerManager;
  public readonly feishuClientPublic: FeishuClient;
  public readonly sessionManagerPublic: SessionManager;

  constructor(config: XiaoZhiConfig) {
    this.model = config.model || 'claude-sonnet-4-5-20250929';
    this.usePersistentSession = config.usePersistentSession ?? true;

    // 初始化存储
    this.storage = new SQLiteStorage(config.storage.path);

    // 初始化飞书客户端
    this.feishuClient = new FeishuClient(config.feishu);

    // 初始化会话管理器
    this.sessionManager = new SessionManager(this.storage, {
      maxContextMessages: 50,
      compressThreshold: 40,
    });

    // 初始化Worker管理器
    this.workerManager = new WorkerManager(this.storage, {
      baseDir: config.worker.baseDir,
      scriptsDir: config.worker.scriptsDir,
      xiaozhiHost: 'localhost',
      xiaozhiPort: config.worker.hooksPort,
    });

    // 初始化常驻Claude会话
    if (this.usePersistentSession) {
      this.claudeSession = new ClaudeSession({
        sessionName: 'xiaozhi-claude',
      });
    }

    // 公开访问
    this.workerManagerPublic = this.workerManager;
    this.feishuClientPublic = this.feishuClient;
    this.sessionManagerPublic = this.sessionManager;

    // 设置飞书消息处理器
    this.feishuClient.setMessageHandler(this.handleMessage.bind(this));
  }

  /**
   * 启动服务
   */
  async start(): Promise<void> {
    // 启动常驻Claude会话
    if (this.claudeSession) {
      logger.info('启动常驻Claude会话...');
      await this.claudeSession.start();
    }

    await this.feishuClient.start();
    logger.info('XiaoZhi service started');
  }

  /**
   * 停止服务
   * 注意：常驻会话不会被销毁，程序重启后可以复用
   */
  async stop(): Promise<void> {
    // 断开常驻Claude会话（不销毁，保留供下次启动复用）
    if (this.claudeSession) {
      await this.claudeSession.stop();
    }

    await this.feishuClient.stop();
    this.storage.close();
    logger.info('XiaoZhi service stopped');
  }

  // 配置
  private readonly PROGRESS_NOTIFY_DELAY = 8000; // 8秒后发送进度提示

  /**
   * 处理飞书消息
   */
  async handleMessage(msg: FeishuMessage): Promise<void> {
    const msgId = msg.messageId.slice(-8);
    const t0 = Date.now();
    logger.info(`[${msgId}] 收到飞书消息: ${msg.content.slice(0, 30)}...`);

    // 进度提示相关
    let progressSent = false;
    let progressTimer: NodeJS.Timeout | null = null;

    const sendProgressNotice = async () => {
      if (!progressSent) {
        progressSent = true;
        const elapsed = Math.round((Date.now() - t0) / 1000);
        logger.info(`[${msgId}] 发送进度提示 (已等待 ${elapsed}s)`);
        await this.feishuClient.sendMessage(msg.chatId, {
          content: `⏳ 正在处理中，请稍候... (已等待 ${elapsed} 秒)`,
          type: 'text',
        });
      }
    };

    try {
      // 1. 获取或创建会话
      const t1 = Date.now();
      const session = await this.sessionManager.getOrCreate(msg.userId, msg.chatId);
      this.currentSessionId = session.id;
      logger.info(`[${msgId}] 步骤1-获取会话: ${Date.now() - t1}ms`);

      // 2. 添加用户消息到上下文
      const t2 = Date.now();
      await this.sessionManager.addMessage(session.id, {
        role: 'user',
        content: msg.content,
        timestamp: new Date(),
      });
      logger.info(`[${msgId}] 步骤2-保存消息: ${Date.now() - t2}ms`);

      // 3. 构建上下文
      const t3 = Date.now();
      const contextStr = this.buildContextString(session.context);
      logger.info(`[${msgId}] 步骤3-构建上下文: ${Date.now() - t3}ms, 上下文长度: ${contextStr.length}`);

      // 4. 设置进度提示定时器
      progressTimer = setTimeout(sendProgressNotice, this.PROGRESS_NOTIFY_DELAY);

      // 5. 调用Claude处理
      const t4 = Date.now();
      logger.info(`[${msgId}] 步骤4-开始调用Claude...`);
      const response = await this.callClaude(msg.content, contextStr, session.id);
      logger.info(`[${msgId}] 步骤4-Claude响应: ${Date.now() - t4}ms, 响应长度: ${response.text.length}`);

      // 6. 清除进度定时器
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }

      // 7. 发送回复到飞书
      const t5 = Date.now();
      const reply: FeishuReply = {
        content: response.text,
        type: 'text',
      };
      await this.feishuClient.sendMessage(msg.chatId, reply);
      logger.info(`[${msgId}] 步骤5-发送飞书: ${Date.now() - t5}ms`);

      // 8. 添加助手消息到上下文
      const t6 = Date.now();
      await this.sessionManager.addMessage(session.id, {
        role: 'assistant',
        content: response.text,
        timestamp: new Date(),
      });
      logger.info(`[${msgId}] 步骤6-保存回复: ${Date.now() - t6}ms`);

      // 9. 处理工具调用（如果需要创建Worker）
      if (response.createWorker) {
        await this.handleCreateWorker(session.id, response.createWorker, msg.chatId);
      }

      // 10. 检查是否需要压缩历史
      const updatedSession = await this.sessionManager.get(session.id);
      if (updatedSession && this.sessionManager.shouldCompress(updatedSession)) {
        await this.sessionManager.compressHistory(session.id);
      }

      logger.info(`[${msgId}] 总耗时: ${Date.now() - t0}ms`);
    } catch (error) {
      // 清除进度定时器
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }

      logger.error(`[${msgId}] 错误:`, error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '抱歉，处理消息时出现错误。请稍后重试。',
        type: 'text',
      });
    }
  }

  /**
   * 调用Claude处理请求
   * 优先使用常驻会话，否则启动新进程
   */
  private async callClaude(
    userInput: string,
    context: string,
    sessionId: string
  ): Promise<{ text: string; createWorker?: WorkerSpawnConfig }> {
    // 优先使用常驻会话
    if (this.claudeSession && await this.claudeSession.isHealthy()) {
      return this.callClaudePersistent(userInput, context, sessionId);
    }

    // 回退到启动新进程
    return this.callClaudeSpawn(userInput, context, sessionId);
  }

  /**
   * 使用常驻会话调用Claude
   */
  private async callClaudePersistent(
    userInput: string,
    context: string,
    sessionId: string
  ): Promise<{ text: string; createWorker?: WorkerSpawnConfig }> {
    const callStart = Date.now();
    const systemPrompt = this.buildSystemPrompt();
    const fullPrompt = context
      ? `${systemPrompt}\n\n--- 对话上下文 ---\n${context}\n\n--- 用户消息 ---\n${userInput}`
      : `${systemPrompt}\n\n--- 用户消息 ---\n${userInput}`;

    logger.info(`[Claude-Persistent] 发送消息, 提示词长度: ${fullPrompt.length}`);

    try {
      const output = await this.claudeSession!.chat(fullPrompt, 120000);
      const elapsed = Date.now() - callStart;
      logger.info(`[Claude-Persistent] 响应完成, 耗时: ${elapsed}ms, 响应长度: ${output.length}`);

      return this.parseClaudeResponse(output, sessionId);
    } catch (error) {
      logger.error('[Claude-Persistent] 错误:', error);
      // 回退到spawn方式
      logger.info('[Claude-Persistent] 回退到spawn方式');
      return this.callClaudeSpawn(userInput, context, sessionId);
    }
  }

  /**
   * 使用spawn启动新进程调用Claude
   */
  private async callClaudeSpawn(
    userInput: string,
    context: string,
    sessionId: string
  ): Promise<{ text: string; createWorker?: WorkerSpawnConfig }> {
    return new Promise((resolve, reject) => {
      const callStart = Date.now();
      const systemPrompt = this.buildSystemPrompt();
      const fullPrompt = context
        ? `${systemPrompt}\n\n--- 对话上下文 ---\n${context}\n\n--- 用户消息 ---\n${userInput}`
        : `${systemPrompt}\n\n--- 用户消息 ---\n${userInput}`;

      logger.info(`[Claude] 启动进程, 提示词长度: ${fullPrompt.length}`);
      const spawnStart = Date.now();

      const proc = spawn('claude', [
        '--print',
        fullPrompt,
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      logger.info(`[Claude] 进程已启动, PID: ${proc.pid}, spawn耗时: ${Date.now() - spawnStart}ms`);

      let output = '';
      let errorOutput = '';
      let firstChunkTime = 0;

      proc.stdout.on('data', (data) => {
        if (firstChunkTime === 0) {
          firstChunkTime = Date.now();
          logger.info(`[Claude] 首个数据块到达, 等待: ${firstChunkTime - callStart}ms`);
        }
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
        logger.info(`[Claude] stderr: ${data.toString().slice(0, 100)}`);
      });

      proc.on('close', (code) => {
        const elapsed = Date.now() - callStart;
        logger.info(`[Claude] 进程结束, 退出码: ${code}, 总耗时: ${elapsed}ms, 输出长度: ${output.length}`);

        if (code !== 0 && !output) {
          logger.error(`Claude CLI error: ${errorOutput}`);
          reject(new Error(`Claude CLI failed: ${errorOutput}`));
          return;
        }

        // 解析输出，检查是否需要创建Worker
        const result = this.parseClaudeResponse(output, sessionId);
        resolve(result);
      });

      proc.on('error', (err) => {
        logger.error('Failed to start Claude CLI:', err);
        reject(err);
      });

      // 添加120秒超时
      const timeout = setTimeout(() => {
        logger.warn('Claude CLI timeout, killing process');
        proc.kill();
        reject(new Error('Claude CLI timeout'));
      }, 120000);

      proc.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * 构建系统提示词
   */
  private buildSystemPrompt(): string {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `你是AI管家小智，当前正在运行中。

当前状态：
- 运行状态：正常运行
- 飞书连接：已连接
- 当前时间：${now}

你的能力：
1. 回答用户问题
2. 通过飞书与用户通信
3. 创建Worker处理复杂任务

简洁回复用户消息。如需创建Worker处理复杂任务，回复末尾添加:
[WORKER_CREATE]任务描述:xxx[/WORKER_CREATE]`;
  }

  /**
   * 构建上下文字符串
   */
  private buildContextString(context: {
    conversationHistory: Message[];
    activeWorkers: string[];
    summary?: string;
  }): string {
    const parts: string[] = [];

    // 包含最近3条消息
    const recentHistory = context.conversationHistory.slice(-3);
    if (recentHistory.length > 0) {
      parts.push('--- 最近对话 ---');
      parts.push(...recentHistory.map(msg =>
        `${msg.role === 'user' ? '用户' : '小智'}: ${msg.content}`
      ));
    }

    // 包含活跃Worker信息
    if (context.activeWorkers.length > 0) {
      parts.push('--- 活跃Worker ---');
      parts.push(`当前有 ${context.activeWorkers.length} 个Worker正在运行`);
    }

    return parts.join('\n');
  }

  /**
   * 解析Claude响应
   */
  private parseClaudeResponse(
    output: string,
    sessionId: string
  ): { text: string; createWorker?: WorkerSpawnConfig } {
    // 检查是否包含Worker创建标记
    const workerMatch = output.match(
      /\[WORKER_CREATE\]([\s\S]*?)\[\/WORKER_CREATE\]/
    );

    if (workerMatch) {
      const workerConfig = workerMatch[1];
      const textWithoutConfig = output.replace(workerMatch[0], '').trim();

      // 解析Worker配置
      const taskMatch = workerConfig.match(/任务描述:\s*(.+)/);
      const workDirMatch = workerConfig.match(/工作目录:\s*(.+)/);
      const modelMatch = workerConfig.match(/模型:\s*(\w+)/);

      if (taskMatch) {
        return {
          text: textWithoutConfig,
          createWorker: {
            sessionId,
            task: taskMatch[1].trim(),
            workDir: workDirMatch?.[1].trim(),
            model: modelMatch?.[1].trim() as 'sonnet' | 'opus' | 'haiku',
          },
        };
      }
    }

    return { text: output.trim() };
  }

  /**
   * 处理创建Worker
   */
  private async handleCreateWorker(
    sessionId: string,
    config: WorkerSpawnConfig,
    chatId: string
  ): Promise<void> {
    try {
      const worker = await this.workerManager.spawnWorker(config);
      await this.sessionManager.addWorker(sessionId, worker.id);

      // 发送Worker创建通知
      await this.feishuClient.sendCard(chatId, {
        header: {
          title: { content: `🚀 Worker已创建`, tag: 'plain_text' },
          template: 'blue',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**名称**: ${worker.name}\n**ID**: ${worker.id}\n**状态**: 运行中\n**任务**: ${config.task.slice(0, 100)}...`,
          },
        ],
      });

      logger.info(`Worker ${worker.id} created for session ${sessionId}`);
    } catch (error) {
      logger.error('Failed to create worker:', error);
      await this.feishuClient.sendMessage(chatId, {
        content: '❌ 创建Worker失败，请稍后重试。',
        type: 'text',
      });
    }
  }
}
