// src/worker/factory.ts
// Worker工厂 - 创建Worker目录和配置

import * as path from 'path';
import * as fs from 'fs/promises';
import { ClaudeWorker, WorkerSpawnConfig, WorkerHooks, HooksConfig, WorkerManagerConfig } from './types';

export class WorkerFactory {
  private config: WorkerManagerConfig;

  constructor(config: WorkerManagerConfig) {
    this.config = config;
  }

  /**
   * 创建Worker目录结构
   */
  async createWorkerDirectory(workerId: string): Promise<string> {
    const workerDir = path.join(this.config.baseDir, 'workers', workerId);
    const claudeDir = path.join(workerDir, '.claude');

    await fs.mkdir(workerDir, { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });

    return workerDir;
  }

  /**
   * 生成Hooks配置
   */
  generateHooksConfig(workerId: string): HooksConfig {
    const { scriptsDir, baseDir, xiaozhiHost, xiaozhiPort } = this.config;
    const workerDir = path.join(baseDir, 'workers', workerId);

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
  async writeHooksConfig(workerId: string): Promise<string> {
    const workerDir = path.join(this.config.baseDir, 'workers', workerId);
    const settingsPath = path.join(workerDir, '.claude', 'settings.json');

    const hooksConfig = this.generateHooksConfig(workerId);
    const settings = { hooks: hooksConfig };

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  }

  /**
   * 写入任务描述文件
   */
  async writeTaskDescription(workerId: string, task: string): Promise<void> {
    const taskPath = path.join(this.config.baseDir, 'workers', workerId, 'task.md');
    await fs.writeFile(taskPath, `# 任务描述\n\n${task}\n`);
  }

  /**
   * 生成Claude CLI启动命令
   */
  buildClaudeCommand(workerId: string, config: WorkerSpawnConfig): string {
    const workerDir = path.join(this.config.baseDir, 'workers', workerId);
    const logFile = path.join(workerDir, 'output.log');

    const parts = [
      'claude',
      '--print',
      `--session-id "${workerId}"`,
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
    config: WorkerSpawnConfig,
    tmuxSession: string
  ): ClaudeWorker {
    const workerDir = path.join(this.config.baseDir, 'workers', workerId);

    return {
      id: workerId,
      name: config.name || `Worker-${workerId.slice(0, 6)}`,
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
    const metaPath = path.join(
      this.config.baseDir,
      'workers',
      worker.id,
      'meta.json'
    );
    await fs.writeFile(metaPath, JSON.stringify(worker, null, 2));
  }

  /**
   * 加载Worker元数据
   */
  async loadWorkerMeta(workerId: string): Promise<ClaudeWorker | null> {
    const metaPath = path.join(this.config.baseDir, 'workers', workerId, 'meta.json');
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
}
