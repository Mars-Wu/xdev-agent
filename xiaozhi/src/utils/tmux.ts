// src/utils/tmux.ts
// tmux工具封装

import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TmuxSessionOptions {
  name: string;
  cwd?: string;
  detached?: boolean;
}

export class TmuxClient {
  /**
   * 创建新的tmux会话
   */
  async createSession(options: TmuxSessionOptions): Promise<void> {
    const args = ['new-session', '-d', '-s', options.name];
    if (options.cwd) {
      args.push('-c', options.cwd);
    }

    await this.runTmuxCommand(args);
  }

  /**
   * 检查会话是否存在
   */
  async sessionExists(name: string): Promise<boolean> {
    try {
      await this.runTmuxCommand(['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 向会话发送按键
   */
  async sendKeys(sessionName: string, keys: string): Promise<void> {
    await this.runTmuxCommand(['send-keys', '-t', sessionName, keys, 'C-m']);
  }

  /**
   * 向会话发送原始按键（不带回车）
   */
  async sendRawKeys(sessionName: string, keys: string): Promise<void> {
    await this.runTmuxCommand(['send-keys', '-t', sessionName, keys]);
  }

  /**
   * 终止会话
   */
  async killSession(name: string): Promise<void> {
    try {
      await this.runTmuxCommand(['kill-session', '-t', name]);
    } catch {
      // 会话可能已不存在
    }
  }

  /**
   * 设置会话环境变量
   */
  async setEnvironment(
    sessionName: string,
    env: Record<string, string>
  ): Promise<void> {
    for (const [key, value] of Object.entries(env)) {
      await this.runTmuxCommand([
        'set-environment',
        '-t',
        sessionName,
        key,
        value,
      ]);
    }
  }

  /**
   * 获取会话输出（最后一屏）
   */
  async captureOutput(sessionName: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${sessionName} -p`
      );
      return stdout;
    } catch {
      return '';
    }
  }

  /**
   * 列出所有会话
   */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 执行tmux命令
   */
  private async runTmuxCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('tmux', args);
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
          reject(new Error(`tmux command failed: ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }
}
