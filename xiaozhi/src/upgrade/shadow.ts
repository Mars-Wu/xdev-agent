// src/upgrade/shadow.ts
// 小智自我升级系统 - 影子实例管理
// 在不同端口启动新版小智进行测试

import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { ShadowInstance, UpgradeConfig, DEFAULT_UPGRADE_CONFIG } from './types';
import { validateTmuxSessionName, validatePort, shellEscape, validateFilePath } from './security-utils';

const logger = createLogger('upgrade-shadow');

export class ShadowInstanceManager {
  private config: UpgradeConfig;
  private instances: Map<number, ShadowInstance> = new Map();
  private processes: Map<number, ChildProcess> = new Map();

  constructor(config?: Partial<UpgradeConfig>) {
    this.config = { ...DEFAULT_UPGRADE_CONFIG, ...config };
  }

  /**
   * 获取可用端口
   */
  async getAvailablePort(): Promise<number> {
    // 从 shadowPortBase 开始，找一个可用端口
    for (let port = this.config.shadowPortBase; port < this.config.shadowPortBase + 10; port++) {
      if (!this.instances.has(port)) {
        const inUse = await this.isPortInUse(port);
        if (!inUse) {
          return port;
        }
      }
    }
    throw new Error('没有可用的影子实例端口');
  }

  /**
   * 检查端口是否被占用
   */
  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/health',
        method: 'GET',
        timeout: 1000,
      }, (res) => {
        resolve(res.statusCode === 200);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * 启动影子实例
   */
  async start(port: number): Promise<ShadowInstance> {
    // 验证端口号
    if (!validatePort(port)) {
      throw new Error(`无效的端口号: ${port}`);
    }

    if (this.instances.has(port)) {
      const existing = this.instances.get(port)!;
      if (existing.status === 'running') {
        return existing;
      }
    }

    const instance: ShadowInstance = {
      port,
      status: 'starting',
      startedAt: new Date(),
    };

    this.instances.set(port, instance);

    try {
      // 使用 tmux 启动影子实例
      const tmuxSession = `shadow_xiaozhi_${port}`;
      instance.tmuxSession = tmuxSession;

      // 验证 tmux 会话名
      if (!validateTmuxSessionName(tmuxSession)) {
        throw new Error(`无效的 tmux 会话名: ${tmuxSession}`);
      }

      // 先确保 tmux 会话不存在 - 使用 spawn 数组参数
      await this.runTmuxCommand(['kill-session', '-t', tmuxSession], true);

      // P1 安全修复：验证路径
      if (!validateFilePath(this.config.xiaozhiDir, path.join(os.homedir(), 'data', 'claudeClaw'))) {
        throw new Error(`小智目录路径不在预期范围内: ${this.config.xiaozhiDir}`);
      }

      // 创建 tmux 会话并启动影子实例
      // 设置不同的端口和会话目录
      const shadowDir = `${this.config.upgradesDir}/shadow_${port}`;
      await fs.mkdir(shadowDir, { recursive: true });

      // P1 安全修复：使用 shell 转义路径，避免注入
      const escapedXiaozhiDir = shellEscape(this.config.xiaozhiDir);
      const escapedShadowDir = shellEscape(shadowDir);

      // 启动命令 - 使用转义后的路径
      const startCmd = `cd ${escapedXiaozhiDir} && XIAOZHI_HOOKS_PORT=${port} XIAOZHI_HOME=${escapedShadowDir} node dist/index.js`;
      await this.runTmuxCommand(['new', '-d', '-s', tmuxSession, startCmd]);

      logger.info(`影子实例启动中: 端口 ${port}, tmux 会话 ${tmuxSession}`);

      // 等待健康检查通过
      const healthy = await this.waitForHealth(port, 30000);

      if (healthy) {
        instance.status = 'running';
        logger.info(`影子实例已就绪: 端口 ${port}`);
      } else {
        instance.status = 'error';
        throw new Error(`影子实例启动超时: 端口 ${port}`);
      }

      return instance;
    } catch (error) {
      instance.status = 'error';
      logger.error(`影子实例启动失败:`, error);
      throw error;
    }
  }

  /**
   * 等待健康检查通过
   */
  private async waitForHealth(port: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const healthy = await this.checkHealth(port);
        if (healthy) {
          return true;
        }
      } catch {
        // 忽略错误，继续等待
      }
      await this.sleep(1000);
    }

    return false;
  }

  /**
   * 检查影子实例健康状态
   */
  async checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/health',
        method: 'GET',
        timeout: 5000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.status === 'ok');
          } catch {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * 发送测试消息给影子实例
   */
  async sendTestMessage(port: number, content: string): Promise<{ success: boolean; response?: string; error?: string; duration: number }> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        content,
        simulate: true,  // 标记为模拟消息
      });

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/test/message',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: this.config.testTimeout,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const duration = Date.now() - startTime;
          try {
            const json = JSON.parse(data);
            resolve({
              success: res.statusCode === 200,
              response: json.response || data,
              duration,
            });
          } catch {
            resolve({
              success: false,
              error: '响应解析失败',
              response: data,
              duration,
            });
          }
        });
      });

      req.on('error', (error) => {
        resolve({
          success: false,
          error: error.message,
          duration: Date.now() - startTime,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: '请求超时',
          duration: this.config.testTimeout,
        });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * 停止影子实例
   */
  async stop(port: number): Promise<void> {
    const instance = this.instances.get(port);
    if (!instance) {
      return;
    }

    if (instance.tmuxSession && validateTmuxSessionName(instance.tmuxSession)) {
      try {
        await this.runTmuxCommand(['kill-session', '-t', instance.tmuxSession], true);
        logger.info(`影子实例已停止: 端口 ${port}`);
      } catch (error) {
        logger.warn(`停止影子实例失败:`, error);
      }
    }

    instance.status = 'stopped';
    this.instances.delete(port);
  }

  /**
   * 停止所有影子实例
   */
  async stopAll(): Promise<void> {
    for (const port of this.instances.keys()) {
      await this.stop(port);
    }
  }

  /**
   * 获取影子实例状态
   */
  getInstance(port: number): ShadowInstance | undefined {
    return this.instances.get(port);
  }

  /**
   * 获取所有运行中的影子实例
   */
  getRunningInstances(): ShadowInstance[] {
    return Array.from(this.instances.values()).filter(i => i.status === 'running');
  }

  /**
   * 执行 tmux 命令 - 使用 spawn 数组参数避免注入
   */
  private runTmuxCommand(args: string[], ignoreError: boolean = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('tmux', args, {
        cwd: this.config.xiaozhiDir,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 || ignoreError) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed: ${stderr || stdout}`));
        }
      });

      proc.on('error', (error) => {
        if (ignoreError) {
          resolve('');
        } else {
          reject(error);
        }
      });
    });
  }

  /**
   * 执行命令（保留用于兼容性）
   * @deprecated 使用 runTmuxCommand 代替
   */
  private runCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: this.config.xiaozhiDir,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed: ${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * 休眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
