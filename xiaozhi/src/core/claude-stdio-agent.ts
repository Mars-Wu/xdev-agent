// src/core/claude-stdio-agent.ts
// Claude Agent - 使用 stdio 通信，避免 tmux 轮询
// 原理：保持 Claude CLI 进程运行，通过 stdin/stdout 通信

import { spawn, ChildProcess } from 'child_process';
import { FeishuClient } from '../feishu/client';
import { FeishuMessage } from '../feishu/types';
import { createLogger } from '../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const logger = createLogger('claude-stdio-agent');

// 小智系统提示词
const XIAOZHI_PROMPT = `你是AI管家小智，通过飞书与用户沟通的智能助手。
当前时间：{TIME}
简洁友好地回复用户。`;

export interface ClaudeStdioAgentConfig {
  feishuClient: FeishuClient;
  model?: string;
}

interface ResponseChunk {
  type: string;
  content?: string;
  cost?: number;
  duration?: number;
}

export class ClaudeStdioAgent {
  private feishuClient: FeishuClient;
  private model: string;
  private isProcessing: boolean = false;
  private conversationHistory: { role: string; content: string }[] = [];
  private maxHistoryLength: number = 20;
  private sessionDir: string;
  private sessionFile: string;

  constructor(config: ClaudeStdioAgentConfig) {
    this.feishuClient = config.feishuClient;
    this.model = config.model || 'claude-sonnet-4-5-20250929';
    this.sessionDir = path.join(os.homedir(), '.xiaozhi', 'sessions');
    this.sessionFile = path.join(this.sessionDir, 'default.json');
  }

  /**
   * 启动 Agent
   */
  async start(): Promise<void> {
    logger.info('Claude Stdio Agent 启动中...');

    // 确保会话目录存在
    await fs.mkdir(this.sessionDir, { recursive: true });

    // 尝试加载已有会话历史
    await this.loadSession();

    logger.info('Claude Stdio Agent 已就绪');
  }

  /**
   * 停止 Agent（保存会话）
   */
  async stop(): Promise<void> {
    await this.saveSession();
    logger.info('Claude Stdio Agent 已停止，会话已保存');
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

    this.isProcessing = true;
    const startTime = Date.now();

    // 进度提示定时器
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

      // 添加用户消息到历史
      this.conversationHistory.push({
        role: 'user',
        content: msg.content,
      });

      // 调用 Claude（单次调用，通过 --output-format stream-json 检测完成）
      const response = await this.callClaude();

      // 添加助手回复到历史
      this.conversationHistory.push({
        role: 'assistant',
        content: response,
      });

      // 裁剪历史（保持最近20条）
      if (this.conversationHistory.length > this.maxHistoryLength) {
        this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
      }

      clearTimeout(progressTimer);

      const elapsed = Date.now() - startTime;
      logger.info(`响应完成，耗时: ${elapsed}ms`);

      // 发送回复
      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });

    } catch (error) {
      logger.error('处理消息失败:', error);
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
   * 调用 Claude CLI
   * 使用 --output-format stream-json 精确检测完成
   */
  private async callClaude(): Promise<string> {
    return new Promise((resolve, reject) => {
      // 构建带历史的提示词
      const systemPrompt = XIAOZHI_PROMPT.replace('{TIME}',
        new Date().toLocaleString('zh-CN'));

      // 构建完整消息（包含历史）
      const messages = this.conversationHistory.map(m =>
        `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`
      ).join('\n\n');

      const fullPrompt = `${systemPrompt}\n\n--- 对话历史 ---\n${messages}\n\n--- 请回复 ---`;

      logger.info(`调用 Claude，提示词长度: ${fullPrompt.length}`);

      const proc = spawn('claude', [
        '--print',
        '--output-format', 'stream-json',
        '--model', this.model,
        fullPrompt,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let responseText = '';
      let errorOutput = '';
      let isComplete = false;

      // 解析 JSON 流输出
      const parseLine = (line: string) => {
        if (!line.trim()) return;

        try {
          const chunk: ResponseChunk = JSON.parse(line);

          if (chunk.type === 'text' && chunk.content) {
            responseText += chunk.content;
          } else if (chunk.type === 'result') {
            // result 表示完成
            isComplete = true;
            logger.info(`Claude 完成，成本: $${chunk.cost?.toFixed(4) || 0}，耗时: ${chunk.duration?.toFixed(1) || 0}s`);
          } else if (chunk.type === 'error') {
            logger.error('Claude 错误:', chunk.content);
          }
        } catch {
          // 非 JSON 行，可能是普通文本输出
          responseText += line;
        }
      };

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(parseLine);
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0 && !responseText) {
          reject(new Error(`Claude failed: ${errorOutput}`));
        } else {
          resolve(responseText.trim());
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });

      // 120秒超时
      setTimeout(() => {
        if (!isComplete) {
          logger.warn('Claude 超时，强制结束');
          proc.kill();
          if (responseText) {
            resolve(responseText.trim());
          } else {
            reject(new Error('Claude timeout'));
          }
        }
      }, 120000);
    });
  }

  /**
   * 保存会话到文件
   */
  private async saveSession(): Promise<void> {
    try {
      await fs.writeFile(
        this.sessionFile,
        JSON.stringify({
          history: this.conversationHistory,
          updatedAt: new Date().toISOString(),
        }, null, 2)
      );
      logger.info(`会话已保存: ${this.conversationHistory.length} 条消息`);
    } catch (error) {
      logger.error('保存会话失败:', error);
    }
  }

  /**
   * 加载会话
   */
  private async loadSession(): Promise<void> {
    try {
      const data = await fs.readFile(this.sessionFile, 'utf-8');
      const session = JSON.parse(data);
      this.conversationHistory = session.history || [];
      logger.info(`会话已加载: ${this.conversationHistory.length} 条历史消息`);
    } catch {
      logger.info('未找到已有会话，从头开始');
      this.conversationHistory = [];
    }
  }
}
