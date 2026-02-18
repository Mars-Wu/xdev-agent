// src/core/message-handler.ts
// 消息处理器 - 处理特定命令和Worker管理

import { FeishuClient } from '../feishu/client';
import { SessionManager } from '../session/manager';
import { WorkerManager } from '../worker/manager';
import { FeishuMessage } from '../feishu/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('message-handler');

export class MessageHandler {
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager;
  private workerManager: WorkerManager;

  constructor(
    feishuClient: FeishuClient,
    sessionManager: SessionManager,
    workerManager: WorkerManager
  ) {
    this.feishuClient = feishuClient;
    this.sessionManager = sessionManager;
    this.workerManager = workerManager;
  }

  /**
   * 处理命令消息（以/开头的消息）
   */
  async handleCommand(msg: FeishuMessage): Promise<boolean> {
    const content = msg.content.trim();

    // 检查是否是命令
    if (!content.startsWith('/')) {
      return false;
    }

    const [command, ...args] = content.slice(1).split(/\s+/);

    switch (command.toLowerCase()) {
      case 'help':
      case '帮助':
        await this.sendHelp(msg.chatId);
        return true;

      case 'worker':
        await this.handleWorkerCommand(msg.chatId, args);
        return true;

      case 'status':
        await this.handleStatusCommand(msg.chatId, msg.userId);
        return true;

      default:
        return false;
    }
  }

  /**
   * 发送帮助信息
   */
  private async sendHelp(chatId: string): Promise<void> {
    const helpText = `**AI管家小智 - 帮助**

**基本用法**
直接发送消息，小智会帮你处理。

**命令**
- \`/help\` 或 \`/帮助\` - 显示帮助
- \`/worker list\` - 列出当前会话的所有Worker
- \`/worker progress <id>\` - 查看Worker进度
- \`/worker stop <id>\` - 停止Worker
- \`/status\` - 查看会话状态

**任务处理**
- 简单问题直接问
- 复杂任务小智会自动创建Worker处理`;

    await this.feishuClient.sendMessage(chatId, {
      content: helpText,
      type: 'markdown',
    });
  }

  /**
   * 处理Worker命令
   */
  private async handleWorkerCommand(
    chatId: string,
    args: string[]
  ): Promise<void> {
    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
      case 'list':
      case 'ls':
        await this.listWorkers(chatId);
        break;

      case 'progress':
      case 'status':
        await this.showWorkerProgress(chatId, args[1]);
        break;

      case 'stop':
      case 'kill':
        await this.stopWorker(chatId, args[1], args[2] === '-f');
        break;

      default:
        await this.feishuClient.sendMessage(chatId, {
          content: '未知的worker命令。使用 `/help` 查看帮助。',
          type: 'text',
        });
    }
  }

  /**
   * 列出Worker
   */
  private async listWorkers(chatId: string): Promise<void> {
    const session = await this.sessionManager.getOrCreate('system', chatId);
    const workers = await this.workerManager.listBySession(session.id);

    if (workers.length === 0) {
      await this.feishuClient.sendMessage(chatId, {
        content: '当前没有活跃的Worker。',
        type: 'text',
      });
      return;
    }

    const workerList = workers
      .map((w) => {
        const status = w.status === 'running' ? '🟢' : w.status === 'completed' ? '✅' : '❌';
        return `${status} **${w.name}** (${w.id})\n   状态: ${w.status}\n   任务: ${w.task.description.slice(0, 50)}...`;
      })
      .join('\n\n');

    await this.feishuClient.sendCard(chatId, {
      header: {
        title: { content: '📋 Worker列表', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: workerList,
        },
      ],
    });
  }

  /**
   * 显示Worker进度
   */
  private async showWorkerProgress(
    chatId: string,
    workerId?: string
  ): Promise<void> {
    if (!workerId) {
      await this.feishuClient.sendMessage(chatId, {
        content: '请提供Worker ID。使用 `/worker list` 查看所有Worker。',
        type: 'text',
      });
      return;
    }

    const worker = await this.workerManager.getStatus(workerId);
    if (!worker) {
      await this.feishuClient.sendMessage(chatId, {
        content: `Worker ${workerId} 不存在。`,
        type: 'text',
      });
      return;
    }

    const progressText = `**${worker.name}** (${worker.id})

**状态**: ${worker.status}
**当前步骤**: ${worker.progress.currentStep}
**工具调用**: ${worker.progress.toolCalls}次
**已运行**: ${this.formatDuration(worker.startedAt)}

**任务**: ${worker.task.description}`;

    await this.feishuClient.sendCard(chatId, {
      header: {
        title: { content: '📊 Worker进度', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: progressText,
        },
      ],
    });
  }

  /**
   * 停止Worker
   */
  private async stopWorker(
    chatId: string,
    workerId?: string,
    force: boolean = false
  ): Promise<void> {
    if (!workerId) {
      await this.feishuClient.sendMessage(chatId, {
        content: '请提供Worker ID。使用 `/worker list` 查看所有Worker。',
        type: 'text',
      });
      return;
    }

    const worker = await this.workerManager.getStatus(workerId);
    if (!worker) {
      await this.feishuClient.sendMessage(chatId, {
        content: `Worker ${workerId} 不存在。`,
        type: 'text',
      });
      return;
    }

    await this.workerManager.terminate(workerId, force);
    await this.feishuClient.sendMessage(chatId, {
      content: `✅ Worker ${worker.name} 已停止。`,
      type: 'text',
    });
  }

  /**
   * 处理状态命令
   */
  private async handleStatusCommand(
    chatId: string,
    userId: string
  ): Promise<void> {
    const session = await this.sessionManager.getOrCreate(userId, chatId);
    const workers = await this.workerManager.listBySession(session.id);
    const activeWorkers = workers.filter((w) => w.status === 'running');

    const statusText = `**会话状态**

**会话ID**: ${session.id}
**创建时间**: ${session.createdAt.toLocaleString()}
**对话轮数**: ${session.context.conversationHistory.length}
**活跃Workers**: ${activeWorkers.length}

**设置**
- 进度通知: ${session.settings.notifyOnProgress ? '开启' : '关闭'}
- 最大Workers: ${session.settings.maxWorkers}`;

    await this.feishuClient.sendCard(chatId, {
      header: {
        title: { content: '📈 会话状态', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: statusText,
        },
      ],
    });
  }

  /**
   * 格式化时长
   */
  private formatDuration(start?: Date, end: Date = new Date()): string {
    if (!start) return '未开始';
    const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分钟`;
  }
}
