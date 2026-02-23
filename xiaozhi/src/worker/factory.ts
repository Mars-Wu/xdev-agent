// src/worker/factory.ts
// Worker工厂 - 创建Worker目录和配置

import * as path from 'path';
import * as fs from 'fs/promises';
import { ClaudeWorker, WorkerSpawnConfig, WorkerHooks, HooksConfig, WorkerManagerConfig, WorkerIdentifier } from './types';
import { getDefaultModel } from '../config';

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
   * 生成默认的 Worker prompt
   */
  generateDefaultWorkerPrompt(workerName: string, task: string): string {
    return `# AI Worker

你是小智创建的 AI Worker，一个专注于执行特定任务的独立 AI 助手。

## 身份
- 你是一个独立的 AI 助手，专注于完成分配给你的任务
- 你的 Worker 名称: ${workerName}
- 创建者: 小智（AI管家）

## 当前任务

${task}

## 工作规则
1. 专注于完成任务，不要偏离主题
2. 遇到问题时尝试自己解决，实在无法解决时在最终报告中说明
3. 完成任务后，在 output.log 中记录完成状态和结果摘要
4. 不要尝试联系用户或执行与任务无关的操作
5. 你可以自由使用所有可用工具（Bash、Read、Write、Edit 等）

## 输出要求
- 完成任务后，在当前目录的 result.md 中写入：
  - 任务完成状态
  - 主要工作内容
  - 重要发现或结果
  - 遇到的问题（如有）
`;
  }

  /**
   * 写入 Worker 专属的 CLAUDE.md
   * @param workerName Worker 名称
   * @param task 任务描述
   * @param customPrompt 小智生成的自定义 prompt（可选）
   */
  async writeWorkerPrompt(
    workerName: string,
    task: string,
    customPrompt?: string
  ): Promise<string> {
    const workerDir = this.getWorkerDir(workerName);
    const claudeMdPath = path.join(workerDir, 'CLAUDE.md');

    // 如果提供了自定义 prompt，使用它；否则生成默认 prompt
    const prompt = customPrompt || this.generateDefaultWorkerPrompt(workerName, task);

    await fs.writeFile(claudeMdPath, prompt);
    return claudeMdPath;
  }

  /**
   * 在项目目录创建 CLAUDE.md 符号链接
   * 让 Worker 在项目目录运行时能读取到专属配置
   */
  async linkClaudeMdToProject(workerName: string, projectDir: string): Promise<void> {
    const workerDir = this.getWorkerDir(workerName);
    const workerClaudeMd = path.join(workerDir, 'CLAUDE.md');
    const projectClaudeMd = path.join(projectDir, 'CLAUDE.md');

    // 确保项目目录存在
    await fs.mkdir(projectDir, { recursive: true });

    try {
      // 检查项目目录是否已有 CLAUDE.md
      const existingStat = await fs.stat(projectClaudeMd);
      if (existingStat.isSymbolicLink?.()) {
        // 已是符号链接，直接删除替换
        await fs.unlink(projectClaudeMd);
      } else {
        // 是真实文件，备份后替换
        const backupPath = `${projectClaudeMd}.backup-${Date.now()}`;
        await fs.rename(projectClaudeMd, backupPath);
        console.log(`Existing CLAUDE.md backed up to: ${backupPath}`);
      }
    } catch {
      // 文件不存在，直接创建链接
    }

    // 创建符号链接
    await fs.symlink(workerClaudeMd, projectClaudeMd);
    console.log(`CLAUDE.md linked: ${projectClaudeMd} -> ${workerClaudeMd}`);
  }

  /**
   * 生成Claude CLI启动命令
   *
   * 如果指定了 workDir：
   *   - tmux 在 workDir 中运行
   *   - CLAUDE.md 通过符号链接指向 Worker 配置
   *   - Worker 能读取项目文件和自己的配置
   *
   * 如果没有指定 workDir：
   *   - tmux 在 Worker 目录中运行
   *   - Worker 直接读取自己目录的 CLAUDE.md
   */
  buildClaudeCommand(workerName: string, config: WorkerSpawnConfig): string {
    const workerDir = this.getWorkerDir(workerName);
    const logFile = path.join(workerDir, 'output.log');

    const parts = [
      'claude',
      '--print',
      '--dangerously-skip-permissions',
    ];

    // 使用指定的模型或默认模型
    parts.push(`--model ${config.model || getDefaultModel()}`);

    if (config.maxTurns) {
      parts.push(`--max-turns ${config.maxTurns}`);
    }

    if (config.maxBudget) {
      parts.push(`--max-budget-usd ${config.maxBudget}`);
    }

    // 任务描述和日志输出
    // Worker 会读取当前目录的 CLAUDE.md（可能是符号链接）
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
        model: config.model || getDefaultModel(),
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
