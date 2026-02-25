#!/usr/bin/env node
// src/cli/worker-cli.ts
// AI Worker CLI 工具 - 让小智可以通过 Bash tool 调用

import { program } from 'commander';
import { WorkerManager } from '../worker/manager';
import { SQLiteStorage } from '../storage/sqlite';
import { getDefaultModel } from '../config';
import * as path from 'path';
import * as os from 'os';

// 从统一配置读取默认模型
const DEFAULT_MODEL = getDefaultModel();

// 初始化配置（复用 index.ts 的配置逻辑）
const xiaozhiHome = process.env.XIAOZHI_HOME || path.join(os.homedir(), '.xiaozhi');
const storage = new SQLiteStorage(path.join(xiaozhiHome, 'xiaozhi.db'));
const manager = new WorkerManager(storage, {
  baseDir: path.join(xiaozhiHome, 'workers'),
  scriptsDir: path.join(xiaozhiHome, 'scripts'),
  xiaozhiHost: 'localhost',
  xiaozhiPort: parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081'),
});

// 格式化时间
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// 格式化 Worker 状态输出
function formatWorkerStatus(worker: Awaited<ReturnType<typeof manager.getStatus>>): string {
  if (!worker) return 'Worker not found';

  const lines = [
    `ID: ${worker.id}`,
    `Name: ${worker.name}`,
    `Status: ${worker.status}`,
    `Task: ${worker.task.description.slice(0, 100)}${worker.task.description.length > 100 ? '...' : ''}`,
    `Model: ${worker.task.model}`,
    `Work Dir: ${worker.task.workDir}`,
    `Created: ${worker.createdAt.toISOString()}`,
  ];

  if (worker.startedAt) {
    lines.push(`Started: ${worker.startedAt.toISOString()}`);
  }

  if (worker.progress) {
    lines.push(`Progress: ${worker.progress.percentage}%`);
    lines.push(`Tool Calls: ${worker.progress.toolCalls}`);
  }

  if (worker.result) {
    lines.push(`--- Result ---`);
    lines.push(`Success: ${worker.result.success}`);
    lines.push(`Summary: ${worker.result.summary}`);
    lines.push(`Cost: $${worker.result.cost.toFixed(4)}`);
    lines.push(`Duration: ${formatDuration(worker.result.duration)}`);
  }

  return lines.join('\n');
}

// CLI 程序定义
program
  .name('xiaozhi-worker')
  .description('AI Worker CLI - 管理 AI Worker 执行长时间任务')
  .version('1.0.0');

// create 命令
program.command('create <task>')
  .description('创建并启动一个新的 AI Worker')
  .option('-m, --model <model>', `使用的模型 (默认: ${DEFAULT_MODEL})`, DEFAULT_MODEL)
  .option('-t, --timeout <seconds>', '超时时间（秒）')
  .option('-w, --work-dir <path>', '工作目录（Worker 执行任务的目录）')
  .option('--max-turns <n>', '最大对话轮数', parseInt)
  .option('--max-budget <usd>', '最大预算（美元）', parseFloat)
  .option('--session-id <id>', '父会话 ID', 'default')
  .option('-n, --name <name>', 'Worker 名称（用于目录名）')
  .option('-p, --prompt <prompt>', '自定义 Worker prompt（可传入文件路径或直接文本）')
  .action(async (task, options) => {
    try {
      console.log(`Creating Worker for task: ${task.slice(0, 50)}...`);

      // 处理自定义 prompt
      let customPrompt: string | undefined;
      if (options.prompt) {
        // 如果是文件路径，读取文件内容
        if (options.prompt.startsWith('/') || options.prompt.startsWith('./')) {
          const { readFileSync, existsSync } = await import('fs');
          if (existsSync(options.prompt)) {
            customPrompt = readFileSync(options.prompt, 'utf-8');
            console.log(`Using custom prompt from: ${options.prompt}`);
          } else {
            console.warn(`Prompt file not found: ${options.prompt}, using default`);
          }
        } else {
          // 直接使用作为 prompt 文本
          customPrompt = options.prompt;
        }
      }

      const worker = await manager.spawnWorker({
        sessionId: options.sessionId,
        name: options.name,
        task,
        workDir: options.workDir,
        model: options.model,
        timeout: options.timeout ? parseInt(options.timeout) * 1000 : undefined,
        maxTurns: options.maxTurns,
        maxBudget: options.maxBudget,
        customPrompt,
      });

      console.log('\n✅ Worker created successfully!');
      console.log(formatWorkerStatus(worker));
      console.log(`\nView output: tmux attach -t ${worker.tmuxSession}`);
      console.log(`Worker directory: ${path.join(xiaozhiHome, 'workers', worker.name)}`);
    } catch (error) {
      console.error('Failed to create Worker:', error);
      process.exit(1);
    }
  });

// list 命令
program.command('list')
  .description('列出所有 Worker')
  .option('-s, --session-id <id>', '按会话 ID 筛选')
  .option('-a, --all', '显示所有状态的 Worker（包括已完成的）')
  .action(async (options) => {
    try {
      // 如果指定了 session-id，按会话筛选
      const workers = options.sessionId
        ? await manager.listBySession(options.sessionId)
        : await manager.listBySession('default');

      if (workers.length === 0) {
        console.log('No workers found.');
        return;
      }

      // 筛选状态（默认不显示已完成的）
      const displayWorkers = options.all
        ? workers
        : workers.filter(w => w.status !== 'completed' && w.status !== 'failed');

      if (displayWorkers.length === 0) {
        console.log('No active workers. Use --all to see completed workers.');
        return;
      }

      console.log(`Found ${displayWorkers.length} worker(s):\n`);

      for (const worker of displayWorkers) {
        const statusEmoji = {
          pending: '⏳',
          running: '🔄',
          paused: '⏸️',
          completed: '✅',
          failed: '❌',
          timeout: '⏱️',
        }[worker.status] || '❓';

        console.log(`${statusEmoji} ${worker.id} (${worker.status})`);
        console.log(`   Task: ${worker.task.description.slice(0, 60)}...`);
        console.log(`   Model: ${worker.task.model} | Progress: ${worker.progress?.percentage || 0}%`);
        console.log(`   Tmux: ${worker.tmuxSession}`);
        console.log('');
      }
    } catch (error) {
      console.error('Failed to list workers:', error);
      process.exit(1);
    }
  });

// status 命令
program.command('status <worker-id>')
  .description('查看 Worker 详细状态')
  .action(async (workerId) => {
    try {
      const worker = await manager.getStatus(workerId);

      if (!worker) {
        console.log(`Worker ${workerId} not found.`);
        process.exit(1);
      }

      console.log(formatWorkerStatus(worker));

      if (worker.status === 'running') {
        console.log(`\nView live output: tmux attach -t ${worker.tmuxSession}`);
      }
    } catch (error) {
      console.error('Failed to get worker status:', error);
      process.exit(1);
    }
  });

// stop 命令
program.command('stop <worker-id>')
  .description('停止 Worker')
  .option('-f, --force', '强制终止（发送 SIGKILL）')
  .action(async (workerId, options) => {
    try {
      const worker = await manager.getStatus(workerId);

      if (!worker) {
        console.log(`Worker ${workerId} not found.`);
        process.exit(1);
      }

      if (worker.status !== 'running') {
        console.log(`Worker is not running (status: ${worker.status})`);
        return;
      }

      console.log(`Stopping worker ${workerId}...`);
      await manager.terminate(workerId, options.force);
      console.log('✅ Worker stopped.');
    } catch (error) {
      console.error('Failed to stop worker:', error);
      process.exit(1);
    }
  });

// attach 命令（便捷方式）
program.command('attach <worker-id>')
  .description('附加到 Worker 的 tmux 会话查看实时输出')
  .action(async (workerId) => {
    try {
      const worker = await manager.getStatus(workerId);

      if (!worker) {
        console.log(`Worker ${workerId} not found.`);
        process.exit(1);
      }

      console.log(`Attaching to worker ${workerId}...`);
      console.log('Press Ctrl+B then D to detach.');
      // P0 安全修复：使用 spawn 数组参数避免命令注入
      const { spawn } = await import('child_process');
      spawn('tmux', ['attach', '-t', worker.tmuxSession], { stdio: 'inherit' });
    } catch (error) {
      console.error('Failed to attach to worker:', error);
      process.exit(1);
    }
  });

// 解析命令行参数
program.parse();
