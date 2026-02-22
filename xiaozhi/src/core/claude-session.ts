// src/core/claude-session.ts
// 常驻Claude会话管理 - 使用tmux保持CLI常驻
// 设计原则：会话独立于程序生命周期，程序重启不销毁会话

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TmuxClient } from '../utils/tmux';
import { createLogger } from '../utils/logger';

const logger = createLogger('claude-session');

// 完成标记文件目录
const XIAOZHI_RUN_DIR = path.join(os.homedir(), '.xiaozhi', 'run');

export interface ClaudeSessionConfig {
  sessionName: string;
  systemPrompt?: string;
  useHooks?: boolean; // 是否使用hooks检测完成（默认true）
}

export class ClaudeSession {
  private tmux: TmuxClient;
  private sessionName: string;
  private systemPrompt: string;
  private isReady: boolean = false;
  private isProcessing: boolean = false;
  private lastOutputHash: string = '';
  private outputBuffer: string = '';
  private useHooks: boolean;
  private completionFile: string;

  constructor(config: ClaudeSessionConfig) {
    this.tmux = new TmuxClient();
    this.sessionName = config.sessionName;
    this.systemPrompt = config.systemPrompt || '';
    this.useHooks = config.useHooks ?? true;
    this.completionFile = path.join(XIAOZHI_RUN_DIR, `${config.sessionName}.done`);
  }

  /**
   * 启动常驻Claude会话
   * 会话独立于程序生命周期，程序重启不会销毁会话
   */
  async start(): Promise<void> {
    logger.info(`启动常驻Claude会话: ${this.sessionName}`);

    // 确保运行目录存在
    await fs.mkdir(XIAOZHI_RUN_DIR, { recursive: true });

    // 检查会话是否已存在（复用已有会话）
    if (await this.tmux.sessionExists(this.sessionName)) {
      logger.info(`会话 ${this.sessionName} 已存在，复用`);
      this.isReady = true;
      // 检查会话是否健康（Claude是否还在运行）
      const output = await this.tmux.captureOutput(this.sessionName);
      if (output.includes('Claude') || output.includes('╭')) {
        logger.info('复用的会话健康，Claude正在运行');
      } else {
        logger.warn('复用的会话可能不健康，Claude可能已退出');
        // 可以选择重建会话
      }
      return;
    }

    // 创建新的tmux会话
    await this.tmux.createSession({
      name: this.sessionName,
      detached: true,
    });

    // 等待tmux会话初始化
    await this.sleep(500);

    // 启动claude CLI (交互模式)
    logger.info('启动 claude CLI...');
    await this.tmux.sendKeys(this.sessionName, 'claude');

    // 等待Claude启动完成
    await this.waitForClaudeReady();

    this.isReady = true;
    logger.info('Claude会话已就绪');
  }

  /**
   * 等待Claude启动完成
   */
  private async waitForClaudeReady(): Promise<void> {
    const maxWait = 30000; // 最多等待30秒
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const output = await this.tmux.captureOutput(this.sessionName);
      // Claude启动后会显示提示符或欢迎信息
      if (output.includes('│') || output.includes('>') || output.includes('Claude')) {
        logger.info('Claude已启动完成');
        await this.sleep(500); // 额外等待确保稳定
        return;
      }
      await this.sleep(500);
    }

    logger.warn('Claude启动超时，但继续执行');
  }

  /**
   * 发送消息并获取响应
   * 使用文件标记 + 轮询混合检测完成状态
   */
  async chat(userMessage: string, timeout: number = 60000): Promise<string> {
    if (!this.isReady) {
      throw new Error('Claude会话未就绪');
    }

    if (this.isProcessing) {
      throw new Error('Claude正在处理其他请求');
    }

    this.isProcessing = true;
    this.outputBuffer = '';

    // 清理旧的完成标记文件
    try {
      await fs.unlink(this.completionFile);
    } catch {}

    try {
      // 清空之前的输出（发送Ctrl+L清屏）
      await this.tmux.sendRawKeys(this.sessionName, 'C-l');
      await this.sleep(300);

      // 构建消息（添加完成标记指令）
      const fullMessage = this.useHooks
        ? `${userMessage}\n\n[完成后请回复: XIAOZHI_DONE]`
        : userMessage;

      // 发送消息内容
      await this.tmux.sendRawKeys(this.sessionName, fullMessage);
      await this.sleep(100);

      // 发送回车提交
      await this.tmux.sendRawKeys(this.sessionName, 'Enter');

      logger.info(`已发送消息，等待响应...`);

      // 等待响应完成
      const response = await this.waitForResponse(timeout);
      return response;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 等待Claude响应完成
   * 使用混合策略：标记检测 + 输出稳定性检测
   */
  private async waitForResponse(timeout: number): Promise<string> {
    const startTime = Date.now();
    let stableCount = 0;
    let lastOutput = '';
    let lastLength = 0;
    const stableThreshold = 2; // 连续2次输出相同视为完成
    let checkInterval = 200; // 初始200ms，动态调整

    while (Date.now() - startTime < timeout) {
      await this.sleep(checkInterval);

      const currentOutput = await this.tmux.captureOutput(this.sessionName);

      // 方式1: 检测完成标记
      if (this.useHooks && currentOutput.includes('XIAOZHI_DONE')) {
        logger.info(`检测到完成标记，耗时: ${Date.now() - startTime}ms`);
        return this.parseResponse(currentOutput.replace('XIAOZHI_DONE', '').trim());
      }

      // 方式2: 检测输出稳定性
      if (currentOutput === lastOutput && currentOutput.length > 0) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          logger.info(`响应完成（稳定检测），耗时: ${Date.now() - startTime}ms`);
          return this.parseResponse(currentOutput);
        }
      } else {
        stableCount = 0;
      }

      // 动态调整轮询间隔：输出还在变化时用短间隔，稳定后用长间隔
      if (currentOutput.length > lastLength) {
        checkInterval = 200; // 输出增长，用短间隔
      } else if (stableCount > 0) {
        checkInterval = 500; // 开始稳定，用长间隔
      }
      lastLength = currentOutput.length;
      lastOutput = currentOutput;
    }

    logger.warn('响应超时，返回当前输出');
    return this.parseResponse(lastOutput);
  }

  /**
   * 解析Claude输出，提取实际响应内容
   */
  private parseResponse(rawOutput: string): string {
    // 移除ANSI转义序列
    let cleaned = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    // 移除常见的UI元素
    cleaned = cleaned.replace(/[│║┌┐└┘├┤┬┴┼─═]/g, '');

    // 按行处理
    const lines = cleaned.split('\n');
    const responseLines: string[] = [];
    let inResponse = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过空行和提示符
      if (!trimmed || trimmed.startsWith('> ') || trimmed === '>') {
        continue;
      }

      // 检测响应开始（用户消息之后的内容）
      if (trimmed.includes('用户:') || trimmed.includes('User:')) {
        inResponse = false;
        continue;
      }

      // 跳过输入框相关的行
      if (trimmed.includes('[Enter]') || trimmed.includes('Ctrl+C')) {
        continue;
      }

      // 收集响应内容
      if (trimmed.length > 0) {
        responseLines.push(trimmed);
      }
    }

    return responseLines.join('\n').trim();
  }

  /**
   * 停止会话（仅标记状态，不销毁tmux会话）
   * 会话独立于程序生命周期，程序重启后会话继续存在
   */
  async stop(): Promise<void> {
    // 不销毁tmux会话，只标记状态
    // 这样程序重启后可以复用已有会话
    this.isReady = false;
    logger.info('Claude会话已断开（tmux会话保留）');
  }

  /**
   * 强制销毁会话（仅用于维护/清理）
   */
  async destroy(): Promise<void> {
    if (await this.tmux.sessionExists(this.sessionName)) {
      await this.tmux.killSession(this.sessionName);
    }
    this.isReady = false;
    logger.info('Claude会话已销毁');
  }

  /**
   * 检查会话状态
   */
  async isHealthy(): Promise<boolean> {
    if (!await this.tmux.sessionExists(this.sessionName)) {
      return false;
    }
    // 检查输出中是否有Claude运行的迹象
    const output = await this.tmux.captureOutput(this.sessionName);
    return output.includes('Claude') || output.includes('╭') || output.includes('❯');
  }

  /**
   * 辅助函数：sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
