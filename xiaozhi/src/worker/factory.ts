// src/worker/factory.ts
// Worker工厂 - 创建Worker目录和配置

import * as path from 'path';
import * as fs from 'fs/promises';
import { ClaudeWorker, WorkerSpawnConfig, WorkerHooks, HooksConfig, WorkerManagerConfig, WorkerIdentifier } from './types';

export class WorkerFactory {
  private config: WorkerManagerConfig;

  constructor(config: WorkerManagerConfig) {
    this.config = config;
  }

  /**
   * 获取Worker目录路径 - 使用 workerName 作为目录名
   */
  getWorkerDir(workerName: string): string {
    return path.join(this.config.baseDir, workerName);
  }

  /**
   * 创建Worker目录结构
   * 目录结构: ~/data/{worker-name}/
   */
  async createWorkerDirectory(workerName: string): Promise<string> {
    const workerDir = this.getWorkerDir(workerName);
    const claudeDir = path.join(workerDir, '.claude');

    await fs.mkdir(workerDir, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });

    return workerDir;
  }

  /**
   * 写入 .worker.json 标识文件
   */
  async writeWorkerIdentifier(
    workerId: string,
    workerName: string,
    sessionId: string,
    status: 'pending' | 'running' | 'completed' | 'failed' = 'pending'
  ): Promise<void> {
    const workerDir = this.getWorkerDir(workerName);
    const identifierPath = path.join(workerDir, '.worker.json');

    const identifier: WorkerIdentifier = {
      id: workerId,
      name: workerName,
      type: 'claude-worker',
      createdAt: new Date().toISOString(),
      sessionId,
      status,
    };

    await fs.writeFile(identifierPath, JSON.stringify(identifier, null, 2));
  }

  /**
   * 读取 Worker 标识文件
   */
  async readWorkerIdentifier(workerName: string): Promise<WorkerIdentifier | null> {
    const identifierPath = path.join(this.getWorkerDir(workerName), '.worker.json');
    try {
      const content = await fs.readFile(identifierPath, 'utf-8');
      return JSON.parse(content) as WorkerIdentifier;
    } catch {
      return null;
    }
  }

  /**
   * 更新 Worker 状态
   */
  async updateWorkerStatus(workerName: string, status: WorkerIdentifier['status']): Promise<void> {
    const identifier = await this.readWorkerIdentifier(workerName);
    if (identifier) {
      identifier.status = status;
      const identifierPath = path.join(this.getWorkerDir(workerName), '.worker.json');
      await fs.writeFile(identifierPath, JSON.stringify(identifier, null, 2));
    }
  }

  /**
   * 生成Hooks配置
   */
  generateHooksConfig(workerId: string, workerName: string): HooksConfig {
    const { scriptsDir, xiaozhiHost, xiaozhiPort } = this.config;
    const workerDir = this.getWorkerDir(workerName);

    return {
      Notification: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `XIAOZHI_HOST=${xiaozhiHost} XIAOZHI_PORT=${xiaozhiPort} ${scriptsDir}/notify_xiaozhi.sh ${workerId}`,
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `XIAOZHI_HOST=${xiaozhiHost} XIAOZHI_PORT=${xiaozhiPort} ${scriptsDir}/worker_completed.sh ${workerId}`,
            },
          ],
        },
      ],
      SubagentStop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `XIAOZHI_HOST=${xiaozhiHost} XIAOZHI_PORT=${xiaozhiPort} ${scriptsDir}/subagent_notify.sh ${workerId}`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Edit|Write|Bash',
          hooks: [
            {
              type: 'command',
              command: `echo "$(date -Iseconds): tool_used" >> ${workerDir}/actions.log`,
            },
          ],
        },
      ],
    };
  }

  /**
   * 写入Hooks配置文件
   */
  async writeHooksConfig(workerId: string, workerName: string): Promise<string> {
    const workerDir = this.getWorkerDir(workerName);
    const settingsPath = path.join(workerDir, '.claude', 'settings.json');

    const hooksConfig = this.generateHooksConfig(workerId, workerName);
    const settings = { hooks: hooksConfig };

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  }

  /**
   * 写入任务描述文件
   */
  async writeTaskDescription(workerName: string, task: string): Promise<void> {
    const taskPath = path.join(this.getWorkerDir(workerName), 'task.md');
    await fs.writeFile(taskPath, `# 任务描述\n\n${task}\n`);
  }

  /**
   * 生成Claude CLI启动命令
   */
  buildClaudeCommand(workerName: string, config: WorkerSpawnConfig): string {
    const workerDir = this.getWorkerDir(workerName);
    const logFile = path.join(workerDir, 'output.log');

    const parts = [
      'claude',
      '--print',
      '--dangerously-skip-permissions',
    ];

    if (config.workDir) {
      parts.push(`--add-dir "${config.workDir}"`);
    }

    if (config.model) {
      parts.push(`--model ${config.model}`);
    }

    if (config.maxTurns) {
      parts.push(`--max-turns ${config.maxTurns}`);
    }

    if (config.maxBudget) {
      parts.push(`--max-budget-usd ${config.maxBudget}`);
    }

    // 任务描述和日志输出
    parts.push(`"${config.task.replace(/"/g, '\\"')}" 2>&1 | tee "${logFile}"`);

    return parts.join(' ');
  }

  /**
   * 创建Worker元数据
   */
  createWorkerMetadata(
    workerId: string,
    workerName: string,
    config: WorkerSpawnConfig,
    tmuxSession: string
  ): ClaudeWorker {
    const workerDir = this.getWorkerDir(workerName);

    return {
      id: workerId,
      name: workerName,
      sessionId: config.sessionId,
      status: 'pending',
      tmuxSession,
      claudeSessionId: workerId,
      task: {
        description: config.task,
        workDir: config.workDir || workerDir,
        model: config.model || 'sonnet',
        timeout: config.timeout,
        maxTurns: config.maxTurns,
        maxBudget: config.maxBudget,
      },
      progress: {
        percentage: 0,
        currentStep: '初始化',
        toolCalls: 0,
        filesModified: 0,
        lastUpdate: new Date(),
      },
      hooks: {
        progressFile: path.join(workerDir, 'progress.json'),
        notifyScript: path.join(this.config.scriptsDir, 'notify_xiaozhi.sh'),
        completedScript: path.join(this.config.scriptsDir, 'worker_completed.sh'),
      },
      createdAt: new Date(),
    };
  }

  /**
   * 保存Worker元数据到文件
   */
  async saveWorkerMeta(worker: ClaudeWorker): Promise<void> {
    const metaPath = path.join(this.getWorkerDir(worker.name), 'meta.json');
    await fs.writeFile(metaPath, JSON.stringify(worker, null, 2));
  }

  /**
   * 加载Worker元数据
   */
  async loadWorkerMeta(workerName: string): Promise<ClaudeWorker | null> {
    const metaPath = path.join(this.getWorkerDir(workerName), 'meta.json');
    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(content) as ClaudeWorker;
    } catch {
      return null;
    }
  }

  /**
   * 生成Worker ID
   */
  generateWorkerId(): string {
    return (
      'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    );
  }

  /**
   * 生成Worker名称（用于目录名）
   */
  generateWorkerName(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `worker-${timestamp}`;
  }
}
