// src/expert/executor.ts
// 专家执行器 - 使用 claude --print 调用专家，支持 --continue

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../utils/logger';
import { getDefaultModel } from '../config';
import { SessionManager } from './session-manager';
import {
  ExpertConfig,
  ExpertSession,
  ExpertCallParams,
  ExpertError,
  ExpertErrorCode,
} from './types';

const logger = createLogger('expert-executor');

/**
 * 执行器配置
 */
export interface ExecutorConfig {
  sessionManager: SessionManager;
  serverPort: number;
  defaultTimeout?: number;
  preventRecursion?: boolean;
  healthCheckInterval?: number;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
}

/**
 * 执行器回调
 */
export interface ExecutorCallbacks {
  onComplete?: (sessionId: string, result: ExecutionResult) => void;
  onError?: (sessionId: string, error: ExpertError) => void;
  onTerminated?: (sessionId: string, reason: string) => void;
}

/**
 * 进程信息
 */
interface ProcessInfo {
  process: ChildProcess;
  pid: number;
  startTime: number;
  expertName: string;
  workDir: string;
  lastCheck: number;
}

/**
 * 专家执行器
 *
 * 会话策略：
 * - shouldContinue: true  -> 使用 --continue，继续该工作目录的最近会话
 * - shouldContinue: false -> 新会话（默认）
 *
 * Claude CLI 会话是基于工作目录隔离的，--continue 会自动选择该目录最近的会话
 */
export class ExpertExecutor {
  private sessionManager: SessionManager;
  private serverPort: number;
  private defaultTimeout: number;
  private preventRecursion: boolean;
  private healthCheckInterval: number;

  // 进程管理
  private runningProcesses: Map<string, ProcessInfo> = new Map();
  private timeoutTimers: Map<string, NodeJS.Timeout> = new Map();
  private callbacks: ExecutorCallbacks = {};
  private healthCheckTimer?: NodeJS.Timeout;

  constructor(config: ExecutorConfig) {
    this.sessionManager = config.sessionManager;
    this.serverPort = config.serverPort;
    this.defaultTimeout = config.defaultTimeout || 30 * 60 * 1000; // 30 分钟
    this.preventRecursion = config.preventRecursion ?? true;
    this.healthCheckInterval = config.healthCheckInterval || 60000; // 1 分钟

    // 启动健康检查
    this.startHealthCheck();
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: ExecutorCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 执行专家任务
   */
  async execute(
    expert: ExpertConfig,
    session: ExpertSession,
    params: ExpertCallParams
  ): Promise<void> {
    // 检查递归调用
    if (this.preventRecursion && process.env.XIAOZHI_EXPERT_MODE === 'true') {
      throw this.createError(
        ExpertErrorCode.RECURSION_DENIED,
        '递归调用被禁止：专家不能调用其他专家'
      );
    }

    // 验证工作目录
    const workDir = this.validateWorkDir(params.workDir || expert.workDir);

    // 生成完整 Prompt
    const fullPrompt = await this.generatePrompt(expert, params.task, session.id);

    // 构建命令参数
    const model = params.model || getDefaultModel();
    const args = this.buildClaudeArgs(model, params.shouldContinue);

    logger.info(`执行专家 ${expert.name}: ${params.task.slice(0, 50)}...`);
    logger.debug(`工作目录: ${workDir}`);
    logger.debug(`模型: ${model}`);
    logger.debug(`会话策略: ${params.shouldContinue ? '--continue' : '新会话'}`);

    // 构建环境变量
    const env = this.buildEnv(workDir);

    // 启动进程
    const proc = spawn('claude', args, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    // 检查进程是否成功启动
    if (!proc.pid) {
      const error = this.createError(
        ExpertErrorCode.PROCESS_SPAWN_FAILED,
        `专家 ${expert.name} 进程启动失败`
      );
      logger.error(error.message);
      throw error;
    }

    // 通过 stdin 传递 prompt
    try {
      proc.stdin?.write(fullPrompt);
      proc.stdin?.end();
    } catch (error) {
      logger.error(`写入 stdin 失败:`, error);
    }

    // 记录进程信息
    const processInfo: ProcessInfo = {
      process: proc,
      pid: proc.pid,
      startTime: Date.now(),
      expertName: expert.name,
      workDir,
      lastCheck: Date.now(),
    };
    this.runningProcesses.set(session.id, processInfo);

    // 设置超时
    this.setTimeout(session.id);

    // 进程事件处理
    this.setupProcessHandlers(proc, session.id, expert.name);

    logger.info(`专家 ${expert.name} 已启动 (PID: ${proc.pid}, Session: ${session.id})`);
  }

  /**
   * 构建环境变量
   */
  private buildEnv(workDir: string): NodeJS.ProcessEnv {
    const homeDir = os.homedir();
    const envPath = process.env.PATH || '';

    // 确保包含所有必要的 PATH
    const requiredPaths = [
      `${homeDir}/.local/bin`,
      `${homeDir}/.npm-global/bin`,
      `${homeDir}/.nvm/versions/node/v22.20.0/bin`,
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ];
    const missingPaths = requiredPaths.filter(p => !envPath.includes(p));
    const finalPath = missingPaths.length > 0
      ? [...missingPaths, envPath].join(':')
      : envPath;

    return {
      ...process.env,
      PATH: finalPath,
      XIAOZHI_EXPERT_WORKDIR: workDir,
    };
  }

  /**
   * 设置进程事件处理器
   */
  private setupProcessHandlers(proc: ChildProcess, sessionId: string, expertName: string): void {
    const processInfo = this.runningProcesses.get(sessionId);

    proc.on('error', (error) => {
      logger.error(`专家 ${expertName} 进程错误:`, error);

      const expertError = this.createError(
        ExpertErrorCode.PROCESS_ERROR,
        `进程错误: ${error.message}`,
        { originalError: error.message, sessionId }
      );

      this.cleanup(sessionId, false);
      this.callbacks.onError?.(sessionId, expertError);
    });

    proc.on('exit', (code, signal) => {
      const processInfo = this.runningProcesses.get(sessionId);
      const duration = processInfo ? Date.now() - processInfo.startTime : 0;

      if (code !== 0 && code !== null) {
        logger.warn(`专家 ${expertName} 异常退出 (code: ${code}, signal: ${signal}, duration: ${duration}ms)`);

        // 延迟清理，给完成回调一些时间
        setTimeout(() => {
          if (this.runningProcesses.has(sessionId)) {
            logger.warn(`会话 ${sessionId} 未收到完成回调，执行清理`);

            const expertError = this.createError(
              ExpertErrorCode.PROCESS_EXIT_UNEXPECTED,
              `进程异常退出 (code: ${code})`,
              { exitCode: code, signal, duration }
            );

            this.cleanup(sessionId, false);
            this.callbacks.onError?.(sessionId, expertError);
          }
        }, 5000);
      } else if (code === 0) {
        logger.debug(`专家 ${expertName} 正常退出 (duration: ${duration}ms)`);
      }
    });

    // 捕获 stderr 用于调试
    let stderrOutput = '';
    proc.stderr?.on('data', (data) => {
      stderrOutput += data.toString();
      // 只记录前 500 字符
      if (stderrOutput.length <= 500) {
        logger.debug(`[${expertName}] stderr: ${data.toString().slice(0, 200)}`);
      }
    });
  }

  /**
   * 停止执行
   */
  stop(sessionId: string, reason: string = '手动停止'): void {
    const processInfo = this.runningProcesses.get(sessionId);
    if (!processInfo) {
      logger.debug(`会话 ${sessionId} 不存在或已清理`);
      return;
    }

    const { pid, expertName } = processInfo;

    try {
      // 尝试优雅终止进程组
      process.kill(-pid, 'SIGTERM');
      logger.info(`会话 ${sessionId} (PID: ${pid}) 已发送 SIGTERM: ${reason}`);

      // 3 秒后强制终止
      setTimeout(() => {
        if (this.runningProcesses.has(sessionId)) {
          try {
            process.kill(-pid, 'SIGKILL');
            logger.warn(`会话 ${sessionId} (PID: ${pid}) 强制终止`);
          } catch {
            // 进程可能已经退出
          }
        }
      }, 3000);
    } catch (error) {
      // 进程可能已经退出
      logger.debug(`停止会话 ${sessionId} 时进程已不存在`);
    }

    this.cleanup(sessionId, false);
  }

  /**
   * 处理完成回调
   */
  handleComplete(
    sessionId: string,
    success: boolean,
    result: string,
    duration?: number
  ): void {
    const processInfo = this.runningProcesses.get(sessionId);
    const actualDuration = duration || (processInfo ? Date.now() - processInfo.startTime : 0);

    logger.info(`会话 ${sessionId} 完成: success=${success}, duration=${actualDuration}ms`);
    this.cleanup(sessionId, success);

    const execResult: ExecutionResult = {
      success,
      output: result,
      duration: actualDuration,
    };
    this.callbacks.onComplete?.(sessionId, execResult);
  }

  /**
   * 获取运行中的会话数量
   */
  getRunningCount(): number {
    return this.runningProcesses.size;
  }

  /**
   * 检查会话是否在运行
   */
  isRunning(sessionId: string): boolean {
    return this.runningProcesses.has(sessionId);
  }

  /**
   * 获取所有运行中的进程信息
   */
  getRunningProcesses(): Array<{ sessionId: string; pid: number; expertName: string; duration: number }> {
    const result: Array<{ sessionId: string; pid: number; expertName: string; duration: number }> = [];
    const now = Date.now();

    for (const [sessionId, info] of this.runningProcesses) {
      result.push({
        sessionId,
        pid: info.pid,
        expertName: info.expertName,
        duration: now - info.startTime,
      });
    }

    return result;
  }

  /**
   * 启动健康检查
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      this.checkProcesses();
    }, this.healthCheckInterval);
  }

  /**
   * 检查所有进程健康状态
   */
  private checkProcesses(): void {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 分钟无响应视为过期

    for (const [sessionId, info] of this.runningProcesses) {
      try {
        // 检查进程是否还存在
        process.kill(info.pid, 0);
        info.lastCheck = now;
      } catch {
        // 进程不存在
        logger.warn(`会话 ${sessionId} (PID: ${info.pid}) 进程已不存在，执行清理`);

        const expertError = this.createError(
          ExpertErrorCode.PROCESS_DIED,
          `进程意外终止`,
          { pid: info.pid, expertName: info.expertName }
        );

        this.cleanup(sessionId, false);
        this.callbacks.onError?.(sessionId, expertError);
      }
    }

    // 记录当前运行的进程数
    if (this.runningProcesses.size > 0) {
      logger.debug(`健康检查: ${this.runningProcesses.size} 个专家进程运行中`);
    }
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * 关闭执行器，清理所有资源
   */
  shutdown(): void {
    logger.info('关闭专家执行器...');

    // 停止健康检查
    this.stopHealthCheck();

    // 停止所有运行中的进程
    for (const [sessionId] of this.runningProcesses) {
      this.stop(sessionId, '执行器关闭');
    }

    // 清理所有超时定时器
    for (const [sessionId, timer] of this.timeoutTimers) {
      clearTimeout(timer);
      this.timeoutTimers.delete(sessionId);
    }

    logger.info('专家执行器已关闭');
  }

  /**
   * 构建 Claude 命令参数
   */
  private buildClaudeArgs(model: string, shouldContinue?: boolean): string[] {
    const args: string[] = [];

    if (shouldContinue) {
      args.push('--continue');
      logger.debug('使用 --continue 继续最近会话');
    }

    args.push(
      '--print',
      '--dangerously-skip-permissions',
      '--model', model
    );

    return args;
  }

  /**
   * 生成完整 Prompt（包含回调指令）
   */
  private async generatePrompt(
    expert: ExpertConfig,
    task: string,
    sessionId: string
  ): Promise<string> {
    // 读取专家基础 prompt
    let basePrompt = '';
    try {
      const fs = await import('fs/promises');
      basePrompt = await fs.readFile(expert.promptPath, 'utf-8');
    } catch {
      basePrompt = expert.customPrompt || this.generateDefaultPrompt(expert);
    }

    // 生成回调 URL
    const callbackUrl = `http://localhost:${this.serverPort}/api/callbacks/complete`;

    // 构建完整 prompt
    return `${basePrompt}

---

## 当前任务

${task}

## 完成后回调

任务完成后，**必须**执行以下命令报告结果（带重试机制）：

\`\`\`bash
# 带重试的回调命令（最多尝试 3 次）
for i in 1 2 3; do
  response=$(curl -s -w "\\n%{http_code}" -X POST ${callbackUrl} \\
    -H "Content-Type: application/json" \\
    -d '{"sessionId":"${sessionId}","expert":"${expert.name}","success":true,"result":"任务结果摘要"}' \\
    --connect-timeout 10 \\
    --max-time 30)

  http_code=$(echo "$response" | tail -n1)
  if [ "$http_code" = "200" ]; then
    echo "回调成功"
    break
  fi

  echo "回调失败 (尝试 $i/3), HTTP: $http_code"
  if [ $i -lt 3 ]; then
    sleep 5
  fi
done
\`\`\`

## 重要提醒

1. 完成任务后，**必须**调用上述 curl 命令报告结果
2. 不要跳过报告步骤
3. 即使遇到问题，也要报告失败原因（success: false）
4. 如果回调失败，命令会自动重试最多 3 次
`;
  }

  /**
   * 生成默认 Prompt
   */
  private generateDefaultPrompt(expert: ExpertConfig): string {
    return `# ${expert.description}

你是小智团队的 ${expert.name} 专家。

## 身份
- 名称: ${expert.name}
- 专长: ${expert.specialties.join('、')}

## 工作规则
1. 专注于你的专业领域
2. 遵循最佳实践
3. 完成任务后报告结果
`;
  }

  /**
   * 验证工作目录
   */
  private validateWorkDir(workDir: string): string {
    const normalizedPath = path.resolve(workDir);
    const homeDir = os.homedir();
    const allowedPrefixes = [homeDir, '/tmp', '/var/tmp'];

    const isAllowed = allowedPrefixes.some(prefix => normalizedPath.startsWith(prefix));
    if (!isAllowed) {
      throw this.createError(
        ExpertErrorCode.INVALID_WORKDIR,
        `工作目录不在允许的范围内: ${workDir}`
      );
    }

    if (workDir.includes('..') || workDir.includes('\0')) {
      throw this.createError(
        ExpertErrorCode.INVALID_WORKDIR,
        `无效的工作目录路径: ${workDir}`
      );
    }

    return normalizedPath;
  }

  /**
   * 设置超时
   */
  private setTimeout(sessionId: string): void {
    const existingTimer = this.timeoutTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const processInfo = this.runningProcesses.get(sessionId);
      const duration = processInfo ? Date.now() - processInfo.startTime : 0;

      logger.warn(`会话 ${sessionId} 运行超时 (duration: ${duration}ms)，强制终止`);
      this.stop(sessionId, '超时');

      // 使用 terminated 状态而不是 failed
      // 这样后续的回调将被拒绝，避免状态混乱
      this.callbacks.onTerminated?.(sessionId, `执行超时 (${Math.floor(duration / 1000)}秒)`);

      // 同时触发错误回调用于通知
      const expertError = this.createError(
        ExpertErrorCode.TIMEOUT,
        `任务执行超时 (${duration}ms)`,
        { sessionId, duration }
      );
      this.callbacks.onError?.(sessionId, expertError);
    }, this.defaultTimeout);

    this.timeoutTimers.set(sessionId, timer);
  }

  /**
   * 清理资源
   */
  private cleanup(sessionId: string, success: boolean): void {
    // 清理超时定时器
    const timer = this.timeoutTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(sessionId);
    }

    // 移除进程记录
    const processInfo = this.runningProcesses.get(sessionId);
    if (processInfo) {
      logger.debug(`清理会话 ${sessionId} (PID: ${processInfo.pid}, success: ${success})`);
      this.runningProcesses.delete(sessionId);
    }
  }

  /**
   * 创建专家错误
   */
  private createError(
    code: ExpertErrorCode,
    message: string,
    details?: Record<string, unknown>
  ): ExpertError {
    const error = new Error(message) as ExpertError;
    error.code = code;
    if (details) {
      error.details = details;
    }
    return error;
  }
}
