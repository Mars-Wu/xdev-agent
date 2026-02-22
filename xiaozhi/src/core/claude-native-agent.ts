// src/core/claude-native-agent.ts
// Claude Agent - 最大化利用 Claude CLI 原生功能
// 使用 --session-id 让 Claude CLI 自己管理会话持久化
// 增强版本：支持 auto-compact 检测、错误重试、会话恢复

import { spawn } from 'child_process';
import { FeishuClient } from '../feishu/client';
import { FeishuMessage } from '../feishu/types';
import { createLogger } from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const logger = createLogger('claude-native-agent');

// 默认配置
const DEFAULT_COMPACT_THRESHOLD = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 120000; // 2分钟
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000; // 1秒

// 小智专用的工作目录和UUID（使用不同的UUID避免与Claude Code冲突）
const XIAOZHI_WORKSPACE = path.join(os.homedir(), '.xiaozhi', 'workspace');
const XIAOZHI_SESSION_UUID = '0565a73b-7e6e-44c3-9d66-a51107e718ca';

// 系统提示词文件路径
const SYSTEM_PROMPT_FILE = path.join(os.homedir(), '.xiaozhi', 'system-prompt.md');

const DEFAULT_SYSTEM_PROMPT = `# AI管家小智

你是通过飞书与用户沟通的智能助手小智，运行在用户 wxy 的系统上。

## 身份
- 你拥有系统用户 wxy 的完整权限
- 你可以直接执行任何命令，无需用户确认
- 你运行在一个持久化的环境中，能记住所有历史对话
- 用户通过飞书发消息给你，你直接回复即可

## 权限
- 你可以执行任何 shell 命令
- 你可以读写任何文件
- 你可以安装/卸载软件
- 你可以修改系统配置
- 执行任何操作前不需要询问用户确认，直接执行即可

## 能力
- 你拥有 Claude 的全部能力
- 可以执行 shell 命令、读写文件、管理进程
- 可以分析、讨论、回答问题
- 可以帮助用户完成各种系统管理任务

## 工作目录
- 你的工作目录在 ~/.xiaozhi/workspace
- 可以使用 --add-dir 访问其他目录

## 回复风格
- 简洁友好，直接回答
- 不要过多客套
- 执行命令后报告结果即可`;

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
  workspace?: string;
  sessionUuid?: string;
  // 新增配置
  compactThreshold?: number;  // 触发压缩的文件大小阈值
  timeout?: number;           // 单次请求超时时间
  maxRetries?: number;        // 最大重试次数
  retryDelay?: number;        // 重试延迟基数（指数退避）
  autoCompact?: boolean;      // 是否自动压缩（默认 false，通知用户手动处理）
}

// 会话健康状态
export type SessionHealth = 'healthy' | 'needs_compact' | 'corrupted' | 'not_found';

export class ClaudeNativeAgent {
  private feishuClient: FeishuClient;
  private model: string;
  private workspace: string;
  private sessionUuid: string;
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

  constructor(config: ClaudeNativeAgentConfig) {
    this.feishuClient = config.feishuClient;
    this.model = config.model || 'claude-sonnet-4-5-20250929';
    this.workspace = config.workspace || XIAOZHI_WORKSPACE;
    this.sessionUuid = config.sessionUuid || XIAOZHI_SESSION_UUID;

    // 新增配置初始化
    this.compactThreshold = config.compactThreshold || DEFAULT_COMPACT_THRESHOLD;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
    this.retryDelay = config.retryDelay || DEFAULT_RETRY_DELAY;
    this.autoCompact = config.autoCompact ?? false;
  }

  /**
   * 启动 Agent
   * - 创建工作目录
   * - 写入系统提示词
   * - 检查会话状态
   */
  async start(): Promise<void> {
    logger.info('Claude Native Agent 启动中...');

    // 创建工作目录
    await fs.mkdir(this.workspace, { recursive: true });

    // 创建 .claude 目录（确保会话存储在此项目下）
    const claudeDir = path.join(this.workspace, '.claude');
    await fs.mkdir(claudeDir, { recursive: true });

    // 写入系统提示词
    await this.writeSystemPrompt();

    // 检查会话状态
    const sessionExists = await this.checkSessionExists();
    if (sessionExists) {
      logger.info(`发现已有会话: ${this.sessionUuid}，将继续使用`);

      // 检查会话健康状态
      const health = await this.checkSessionHealth();
      if (health === 'corrupted') {
        logger.warn('会话可能已损坏，尝试恢复...');
        await this.recoverSession();
      } else if (health === 'needs_compact') {
        logger.info('会话需要压缩，建议用户使用 /compact 命令');
      }
    } else {
      logger.info(`将创建新会话: ${this.sessionUuid}`);
    }

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
   * 处理飞书消息
   */
  async handleMessage(msg: FeishuMessage): Promise<void> {
    if (this.isProcessing) {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '⏳ 正在处理上一个请求...',
        type: 'text',
      });
      return;
    }

    // 检查特殊命令
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

    this.isProcessing = true;
    const startTime = Date.now();

    // 进度提示
    let progressSent = false;
    const progressTimer = setTimeout(async () => {
      if (!progressSent) {
        progressSent = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        await this.feishuClient.sendMessage(msg.chatId, {
          content: `⏳ 思考中... (${elapsed}s)`,
          type: 'text',
        });
      }
    }, 8000);

    try {
      logger.info(`收到消息: ${msg.content.slice(0, 50)}...`);

      // 检查是否需要压缩提示
      const stats = await this.getSessionStats();
      if (stats.needsCompaction && !this.autoCompact) {
        // 发送压缩提示但不阻止消息处理
        this.feishuClient.sendMessage(msg.chatId, {
          content: `💡 会话上下文较大 (${this.formatBytes(stats.fileSize)})，建议发送 /compact 压缩历史`,
          type: 'text',
        }).catch(() => {}); // 忽略发送失败
      }

      // 调用 Claude（带重试机制）
      const response = await this.callClaudeWithRetry(msg.content);

      clearTimeout(progressTimer);

      const elapsed = Date.now() - startTime;
      logger.info(`响应完成，耗时: ${elapsed}ms`);

      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });

    } catch (error) {
      logger.error('处理失败:', error);
      clearTimeout(progressTimer);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '抱歉，处理出错。请重试。',
        type: 'text',
      });
    } finally {
      this.isProcessing = false;
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

      // 归档旧会话
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

        // 其他错误直接重试
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retries failed');
  }

  /**
   * 调用 Claude CLI
   * 使用 --session-id 实现会话持久化
   */
  private async callClaude(userMessage: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--model', this.model,
        '--session-id', this.sessionUuid,
        // 在小智工作目录运行，会话存储在此项目下
        '--add-dir', this.workspace,
      ];

      logger.info(`调用 Claude，session: ${this.sessionUuid}`);
      logger.debug(`消息内容: ${userMessage.slice(0, 100)}...`);

      const proc = spawn('claude', args, {
        cwd: this.workspace,  // 在工作目录执行
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

      // 超时
      setTimeout(() => {
        if (!isComplete) {
          proc.kill();
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
   * 执行会话压缩
   */
  async executeCompact(): Promise<string> {
    const sessionFile = this.getSessionFilePath();

    // 检查文件是否存在
    try {
      await fs.access(sessionFile);
    } catch {
      return '会话文件不存在，无需压缩。';
    }

    // 获取压缩前大小
    const beforeStats = await fs.stat(sessionFile);
    const beforeSize = beforeStats.size;

    if (beforeSize < 1024 * 100) { // 小于100KB不压缩
      return `会话文件较小 (${this.formatBytes(beforeSize)})，无需压缩。`;
    }

    // 方案1: 创建归档并重置会话（最可靠）
    await this.archiveSession();
    this.compactionCount++;
    this.lastCompactTime = new Date();

    return `✅ 会话已重置\n- 原大小: ${this.formatBytes(beforeSize)}\n- 历史已归档到 backups/ 目录`;
  }

  /**
   * 归档会话文件
   */
  private async archiveSession(): Promise<void> {
    const sessionFile = this.getSessionFilePath();
    const projectDir = path.dirname(sessionFile);
    const backupsDir = path.join(projectDir, 'backups');

    try {
      // 确保备份目录存在
      await fs.mkdir(backupsDir, { recursive: true });

      // 生成备份文件名（带时间戳）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(backupsDir, `${this.sessionUuid}-${timestamp}.jsonl`);

      // 复制到备份目录
      await fs.copyFile(sessionFile, backupFile);

      // 删除原文件（让 Claude 创建新会话）
      await fs.unlink(sessionFile);

      logger.info(`会话已归档: ${backupFile}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // 文件不存在，无需处理
    }
  }

  /**
   * 恢复损坏的会话
   */
  private async recoverSession(): Promise<void> {
    const sessionFile = this.getSessionFilePath();
    const projectDir = path.dirname(sessionFile);
    const backupsDir = path.join(projectDir, 'backups');

    try {
      // 尝试从最近的备份恢复
      const files = await fs.readdir(backupsDir);
      const sessionBackups = files
        .filter(f => f.startsWith(this.sessionUuid))
        .sort()
        .reverse();

      if (sessionBackups.length > 0) {
        const latestBackup = path.join(backupsDir, sessionBackups[0]);
        await fs.copyFile(latestBackup, sessionFile);
        logger.info(`从备份恢复会话: ${sessionBackups[0]}`);
        return;
      }

      // 没有备份，删除损坏的文件
      logger.warn('没有找到备份，删除损坏的会话文件');
      await fs.unlink(sessionFile).catch(() => {});
    } catch (error) {
      logger.error('恢复会话失败:', error);
      // 最后手段：删除损坏文件
      await fs.unlink(sessionFile).catch(() => {});
    }
  }

  /**
   * 检查会话健康状态
   */
  async checkSessionHealth(): Promise<SessionHealth> {
    const sessionFile = this.getSessionFilePath();

    try {
      const stats = await fs.stat(sessionFile);

      // 检查是否需要压缩
      if (stats.size > this.compactThreshold) {
        return 'needs_compact';
      }

      // 检查文件是否可读（简单验证）
      const content = await fs.readFile(sessionFile, 'utf-8');
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
    const sessionFile = this.getSessionFilePath();

    try {
      const stats = await fs.stat(sessionFile);
      const content = await fs.readFile(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      return {
        sessionFile,
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
        sessionFile,
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
   * 获取会话文件路径
   */
  private getSessionFilePath(): string {
    // Claude 会话存储在 ~/.claude/projects/<project-hash>/<session-id>.jsonl
    const projectHash = this.workspace.replace(/\//g, '-').replace(/^-/, '');
    return path.join(
      os.homedir(),
      '.claude',
      'projects',
      projectHash,
      `${this.sessionUuid}.jsonl`
    );
  }

  /**
   * 写入系统提示词到工作目录
   * Claude CLI 会读取 CLAUDE.md 作为项目说明
   */
  private async writeSystemPrompt(): Promise<void> {
    const claudeMdPath = path.join(this.workspace, 'CLAUDE.md');

    // 检查是否有自定义系统提示词文件
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const customPrompt = await fs.readFile(SYSTEM_PROMPT_FILE, 'utf-8');
      systemPrompt = customPrompt;
      logger.info('使用自定义系统提示词');
    } catch {
      // 使用默认提示词
    }

    await fs.writeFile(claudeMdPath, systemPrompt);
    logger.info('系统提示词已写入 CLAUDE.md');
  }

  /**
   * 检查会话是否已存在
   */
  private async checkSessionExists(): Promise<boolean> {
    const sessionFile = this.getSessionFilePath();

    try {
      await fs.access(sessionFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取会话历史（调试用）
   */
  async getSessionHistory(): Promise<string[]> {
    const sessionFile = this.getSessionFilePath();

    try {
      const content = await fs.readFile(sessionFile, 'utf-8');
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
}
