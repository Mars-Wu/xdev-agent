// src/core/feishu-claude-agent.ts
// 飞书Claude Agent - 一个通过飞书沟通的Claude CLI
// 设计理念：把终端换成飞书，Claude CLI保持原有工作方式

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TmuxClient } from '../utils/tmux';
import { FeishuClient } from '../feishu/client';
import { FeishuMessage } from '../feishu/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('feishu-agent');

// 小智的系统提示词
const XIAOZHI_SYSTEM_PROMPT = `你是AI管家小智，一个通过飞书与用户沟通的智能助手。

## 你的身份
- 你运行在一个持久化的环境中，可以记住之前的对话
- 用户通过飞书发消息给你，你直接回复即可
- 你拥有Claude的全部能力

## 当前状态
- 运行状态：正常运行
- 飞书连接：已连接
- 当前时间：{TIME}

## 你的能力
1. 回答用户问题
2. 分析和讨论
3. 如果需要执行复杂任务，告诉用户你会创建一个Worker来处理

## 回复风格
- 简洁友好
- 直接回答，不要过多客套
- 如果任务复杂，简要说明需要创建Worker处理`;

export interface FeishuClaudeAgentConfig {
  feishuClient: FeishuClient;
  sessionName?: string;
  systemPrompt?: string;
}

export class FeishuClaudeAgent {
  private tmux: TmuxClient;
  private feishuClient: FeishuClient;
  private sessionName: string;
  private systemPrompt: string;
  private isReady: boolean = false;
  private isProcessing: boolean = false;

  constructor(config: FeishuClaudeAgentConfig) {
    this.tmux = new TmuxClient();
    this.feishuClient = config.feishuClient;
    this.sessionName = config.sessionName || 'xiaozhi-agent';
    this.systemPrompt = config.systemPrompt || XIAOZHI_SYSTEM_PROMPT;
  }

  /**
   * 启动Agent
   * - 检查tmux会话是否存在，复用或创建
   * - 启动Claude CLI
   */
  async start(): Promise<void> {
    logger.info(`启动 FeishuClaudeAgent: ${this.sessionName}`);

    // 检查会话是否已存在
    if (await this.tmux.sessionExists(this.sessionName)) {
      const healthy = await this.checkSessionHealth();
      if (healthy) {
        logger.info('会话已存在且健康，复用');
        this.isReady = true;
        return;
      } else {
        logger.info('会话存在但不健康，重建');
        await this.tmux.killSession(this.sessionName);
      }
    }

    // 创建新的tmux会话
    await this.tmux.createSession({
      name: this.sessionName,
      detached: true,
    });

    await this.sleep(500);

    // 启动Claude CLI，带系统提示词
    logger.info('启动 Claude CLI...');
    const prompt = this.systemPrompt.replace('{TIME}', new Date().toLocaleString('zh-CN'));

    // 使用 -p 参数发送初始提示词设置身份
    await this.tmux.sendKeys(this.sessionName, `claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);

    // 等待Claude启动完成
    await this.waitForClaudeReady();

    this.isReady = true;
    logger.info('Claude Agent 已就绪');
  }

  /**
   * 停止Agent（不销毁会话）
   */
  async stop(): Promise<void> {
    this.isReady = false;
    logger.info('Agent 已断开（tmux会话保留）');
  }

  /**
   * 处理飞书消息
   */
  async handleMessage(msg: FeishuMessage): Promise<void> {
    if (!this.isReady) {
      logger.warn('Agent未就绪，跳过消息');
      return;
    }

    if (this.isProcessing) {
      // 正在处理其他消息，发送等待提示
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '⏳ 正在处理上一个请求，请稍候...',
        type: 'text',
      });
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      logger.info(`收到消息: ${msg.content.slice(0, 50)}...`);

      // 8秒后发送进度提示
      let progressSent = false;
      const progressTimer = setTimeout(async () => {
        if (!progressSent) {
          progressSent = true;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          await this.feishuClient.sendMessage(msg.chatId, {
            content: `⏳ 正在思考中... (已等待 ${elapsed} 秒)`,
            type: 'text',
          });
        }
      }, 8000);

      // 发送消息到Claude
      await this.tmux.sendRawKeys(this.sessionName, msg.content);
      await this.sleep(100);
      await this.tmux.sendRawKeys(this.sessionName, 'Enter');

      // 等待响应
      const response = await this.waitForResponse(120000);

      // 清除进度定时器
      clearTimeout(progressTimer);

      const elapsed = Date.now() - startTime;
      logger.info(`响应完成，耗时: ${elapsed}ms`);

      // 发送回复到飞书
      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });

    } catch (error) {
      logger.error('处理消息失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '抱歉，处理消息时出现错误。请稍后重试。',
        type: 'text',
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 等待Claude响应
   */
  private async waitForResponse(timeout: number): Promise<string> {
    const startTime = Date.now();
    let stableCount = 0;
    let lastOutput = '';
    let lastLength = 0;

    while (Date.now() - startTime < timeout) {
      await this.sleep(300);

      const currentOutput = await this.tmux.captureOutput(this.sessionName);

      // 检测输出稳定性
      if (currentOutput === lastOutput && currentOutput.length > 0) {
        stableCount++;
        if (stableCount >= 2) {
          return this.parseResponse(currentOutput);
        }
      } else {
        stableCount = 0;
      }

      lastLength = currentOutput.length;
      lastOutput = currentOutput;
    }

    logger.warn('响应超时');
    return this.parseResponse(lastOutput);
  }

  /**
   * 解析Claude输出
   */
  private parseResponse(rawOutput: string): string {
    // 移除ANSI转义序列
    let cleaned = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    // 移除UI边框字符
    cleaned = cleaned.replace(/[│║┌┐└┘├┤┬┴┼─═]/g, '');

    const lines = cleaned.split('\n');
    const responseLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过空行、提示符、输入提示
      if (!trimmed || trimmed === '>' || trimmed.startsWith('> ')) continue;
      if (trimmed.includes('[Enter]') || trimmed.includes('Ctrl+C')) continue;
      if (trimmed.includes('Try "') || trimmed.includes('? for shortcuts')) continue;

      if (trimmed.length > 0) {
        responseLines.push(trimmed);
      }
    }

    return responseLines.join('\n').trim();
  }

  /**
   * 检查会话健康状态
   */
  private async checkSessionHealth(): Promise<boolean> {
    const output = await this.tmux.captureOutput(this.sessionName);
    return output.includes('Claude') || output.includes('╭') || output.includes('❯');
  }

  /**
   * 等待Claude启动完成
   */
  private async waitForClaudeReady(): Promise<void> {
    const maxWait = 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const output = await this.tmux.captureOutput(this.sessionName);
      if (output.includes('╭') || output.includes('Claude') || output.includes('❯')) {
        logger.info('Claude CLI 已就绪');
        await this.sleep(500);
        return;
      }
      await this.sleep(500);
    }

    logger.warn('Claude启动超时，但继续执行');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
