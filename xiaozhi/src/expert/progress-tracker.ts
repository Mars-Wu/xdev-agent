// src/expert/progress-tracker.ts
// 工作进度追踪器
// 在每个工作目录维护 .xiaozhi-progress.md 文件
// 让后续 Agent 能快速了解历史工作

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { createLogger } from '../utils/logger';

const logger = createLogger('progress-tracker');

/**
 * 进度条目
 */
export interface ProgressEntry {
  timestamp: string;       // ISO 时间戳
  expert: string;          // 专家名称
  action: 'started' | 'progress' | 'completed' | 'failed' | 'note';
  task?: string;           // 任务描述
  summary: string;         // 摘要
  details?: string;        // 详细信息
  artifacts?: string[];    // 生成的文件
  nextSteps?: string[];    // 下一步建议
}

/**
 * 进度文件内容
 */
export interface ProgressFile {
  projectPath: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  entries: ProgressEntry[];
  currentStatus: 'active' | 'paused' | 'completed' | 'blocked';
  pendingTasks: string[];
  completedFeatures: string[];
}

/**
 * 进度追踪器
 */
export class ProgressTracker {
  private progressFileName = '.xiaozhi-progress.md';

  /**
   * 获取进度文件路径
   */
  private getProgressPath(workDir: string): string {
    return path.join(workDir, this.progressFileName);
  }

  /**
   * 检查进度文件是否存在
   */
  async exists(workDir: string): Promise<boolean> {
    try {
      await fs.access(this.getProgressPath(workDir));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 初始化进度文件
   */
  async initialize(workDir: string, projectName?: string): Promise<void> {
    const progressPath = this.getProgressPath(workDir);
    const now = new Date().toISOString();

    const content = `# 工作进度日志

> 项目: ${projectName || path.basename(workDir)}
> 创建时间: ${this.formatTime(now)}
> 最后更新: ${this.formatTime(now)}

---

## 当前状态

- **状态**: 🟢 活跃
- **进行中**: 无
- **待办**: 无

---

## 进度记录

`;

    await fs.writeFile(progressPath, content, 'utf-8');
    logger.info(`创建进度文件: ${progressPath}`);
  }

  /**
   * 添加进度条目
   */
  async addEntry(workDir: string, entry: Omit<ProgressEntry, 'timestamp'>): Promise<void> {
    const progressPath = this.getProgressPath(workDir);
    const now = new Date().toISOString();

    // 确保文件存在
    if (!await this.exists(workDir)) {
      await this.initialize(workDir);
    }

    // 读取现有内容
    let content = await fs.readFile(progressPath, 'utf-8');

    // 格式化新条目
    const statusEmoji: Record<string, string> = {
      started: '🚀',
      progress: '🔄',
      completed: '✅',
      failed: '❌',
      note: '📝',
    };

    const emoji = statusEmoji[entry.action] || '📌';
    const timeStr = this.formatTime(now);

    let entryText = `\n### ${timeStr} - ${emoji} ${entry.expert}\n\n`;

    if (entry.task) {
      entryText += `**任务**: ${entry.task}\n\n`;
    }

    entryText += `${entry.summary}\n\n`;

    if (entry.details) {
      entryText += `<details>\n<summary>详细信息</summary>\n\n${entry.details}\n\n</details>\n\n`;
    }

    if (entry.artifacts && entry.artifacts.length > 0) {
      entryText += `**生成文件**:\n`;
      for (const artifact of entry.artifacts) {
        entryText += `- \`${artifact}\`\n`;
      }
      entryText += '\n';
    }

    if (entry.nextSteps && entry.nextSteps.length > 0) {
      entryText += `**下一步**:\n`;
      for (const step of entry.nextSteps) {
        entryText += `- [ ] ${step}\n`;
      }
      entryText += '\n';
    }

    entryText += '---\n';

    // 更新最后更新时间
    content = content.replace(
      /> 最后更新: .*/,
      `> 最后更新: ${timeStr}`
    );

    // 插入新条目（在 "## 进度记录" 之后）
    const progressSectionIndex = content.indexOf('## 进度记录');
    if (progressSectionIndex !== -1) {
      const insertIndex = content.indexOf('\n', progressSectionIndex) + 1;
      content = content.slice(0, insertIndex) + entryText + content.slice(insertIndex);
    } else {
      content += entryText;
    }

    // 更新当前状态
    if (entry.action === 'completed') {
      content = this.updateStatusSection(content, 'completed', entry.task);
    } else if (entry.action === 'started') {
      content = this.updateStatusSection(content, 'active', entry.task);
    } else if (entry.action === 'failed') {
      content = this.updateStatusSection(content, 'blocked', entry.task);
    }

    await fs.writeFile(progressPath, content, 'utf-8');
    logger.debug(`添加进度条目: ${entry.action} by ${entry.expert}`);
  }

  /**
   * 更新状态区域
   */
  private updateStatusSection(content: string, status: string, task?: string): string {
    const statusMap: Record<string, string> = {
      active: '🟢 活跃',
      paused: '🟡 暂停',
      completed: '✅ 完成',
      blocked: '🔴 阻塞',
    };

    let result = content.replace(
      /- \*\*状态\*\*: .*/,
      `- **状态**: ${statusMap[status] || status}`
    );

    if (task) {
      if (status === 'active') {
        result = result.replace(
          /- \*\*进行中\*\*: .*/,
          `- **进行中**: ${task}`
        );
      } else if (status === 'completed') {
        result = result.replace(
          /- \*\*进行中\*\*: .*/,
          `- **进行中**: 无`
        );
      }
    }

    return result;
  }

  /**
   * 读取最近 N 条进度
   */
  async getRecentProgress(workDir: string, limit: number = 10): Promise<string> {
    const progressPath = this.getProgressPath(workDir);

    if (!await this.exists(workDir)) {
      return '暂无进度记录';
    }

    const content = await fs.readFile(progressPath, 'utf-8');

    // 提取最近的进度条目
    const lines = content.split('\n');
    const entries: string[] = [];
    let currentEntry = '';
    let inEntry = false;
    let entryCount = 0;

    for (const line of lines) {
      if (line.startsWith('### ')) {
        if (currentEntry && inEntry) {
          entries.unshift(currentEntry);
          entryCount++;
          if (entryCount >= limit) break;
        }
        currentEntry = line + '\n';
        inEntry = true;
      } else if (inEntry) {
        currentEntry += line + '\n';
      }
    }

    if (currentEntry && inEntry && entryCount < limit) {
      entries.unshift(currentEntry);
    }

    return entries.slice(0, limit).join('\n');
  }

  /**
   * 获取进度摘要（供 Agent 快速了解）
   */
  async getSummary(workDir: string): Promise<string> {
    const progressPath = this.getProgressPath(workDir);

    if (!await this.exists(workDir)) {
      return '这是一个新项目，暂无历史进度记录。';
    }

    const content = await fs.readFile(progressPath, 'utf-8');

    // 提取状态区域
    const statusMatch = content.match(/## 当前状态[\s\S]*?(?=##|$)/);
    const statusSection = statusMatch ? statusMatch[0] : '';

    // 提取最近 3 条记录
    const recentProgress = await this.getRecentProgress(workDir, 3);

    return `${statusSection}

## 最近工作

${recentProgress}`;
  }

  /**
   * 标记任务完成
   */
  async markCompleted(
    workDir: string,
    expert: string,
    task: string,
    summary: string,
    options?: {
      artifacts?: string[];
      nextSteps?: string[];
    }
  ): Promise<void> {
    await this.addEntry(workDir, {
      expert,
      action: 'completed',
      task,
      summary: `完成: ${summary}`,
      artifacts: options?.artifacts,
      nextSteps: options?.nextSteps,
    });
  }

  /**
   * 标记任务失败
   */
  async markFailed(
    workDir: string,
    expert: string,
    task: string,
    error: string,
    suggestions?: string[]
  ): Promise<void> {
    await this.addEntry(workDir, {
      expert,
      action: 'failed',
      task,
      summary: `任务失败: ${error}`,
      details: suggestions ? `建议:\n${suggestions.map(s => `- ${s}`).join('\n')}` : undefined,
      nextSteps: suggestions,
    });
  }

  /**
   * 记录进度更新
   */
  async updateProgress(
    workDir: string,
    expert: string,
    update: string
  ): Promise<void> {
    await this.addEntry(workDir, {
      expert,
      action: 'progress',
      summary: update,
    });
  }

  /**
   * 添加备注
   */
  async addNote(
    workDir: string,
    expert: string,
    note: string
  ): Promise<void> {
    await this.addEntry(workDir, {
      expert,
      action: 'note',
      summary: note,
    });
  }

  /**
   * 格式化时间
   */
  private formatTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

// 导出单例
export const progressTracker = new ProgressTracker();
