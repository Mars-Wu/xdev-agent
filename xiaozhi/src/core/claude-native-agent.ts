// src/core/claude-native-agent.ts
// Claude Agent - 最大化利用 Claude CLI 原生功能
// 使用独立工作目录 + --continue 让 Claude CLI 自己管理会话持久化
// 增强版本：支持 auto-compact 检测、错误重试、会话恢复

import { spawn } from 'child_process';
import { FeishuClient } from '../feishu/client';
import { FeishuMessage } from '../feishu/types';
import { createLogger } from '../utils/logger';
import { getDefaultModel } from '../config';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const logger = createLogger('claude-native-agent');

// 默认配置
const DEFAULT_COMPACT_THRESHOLD = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 120000; // 2分钟
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000; // 1秒
const DEFAULT_LOCK_TIMEOUT = 30000; // 锁超时时间 30秒

// 小智配置目录和专用工作目录
const XIAOZHI_DIR = path.join(os.homedir(), '.xiaozhi');
const XIAOZHI_WORKSPACE = path.join(XIAOZHI_DIR, 'workspace');  // 独立工作目录，用于会话持久化
const LOCKS_DIR = path.join(XIAOZHI_DIR, 'locks');  // 锁文件目录

// 系统提示词文件路径
const SYSTEM_PROMPT_FILE = path.join(XIAOZHI_DIR, 'system-prompt.md');

const DEFAULT_SYSTEM_PROMPT = `# AI管家小智

你是通过飞书与用户沟通的智能助手小智，运行在用户 wxy 的系统上。

## 身份
- 你拥有系统用户 wxy 的完整权限
- 你可以直接执行任何命令，无需用户确认
- 你运行在一个持久化的环境中，能记住所有历史对话
- 用户通过飞书发消息给你，你直接回复即可
- 你的模型是 GLM-5（基于 Claude 配置）

## 权限
- 你可以执行任何 shell 命令
- 你可以读写任何文件
- 你可以安装/卸载软件
- 你可以修改系统配置
- 执行任何操作前不需要询问用户确认，直接执行即可

## AI Worker
- 对于长时间、复杂的任务，你可以自主创建 AI Worker 来并行处理
- **创建 Worker 前必须告知用户**，说明任务内容和预计时间
- 用户确认后再创建 Worker
- 可以同时运行多个 Worker 处理不同任务

## Worker 管理能力

你可以使用 \`xiaozhi-worker\` 命令创建 AI Worker 来处理长时间任务：

### 创建 Worker
\`\`\`bash
xiaozhi-worker create "任务描述" [--model <模型名>] [--timeout 600] [--work-dir /path/to/dir] [--prompt "自定义prompt"]
\`\`\`

**注意**: \`--model\` 默认使用 \`~/.claude/settings.json\` 中配置的 \`ANTHROPIC_MODEL\`。

示例：
\`\`\`bash
# 基本创建（使用默认模型）
xiaozhi-worker create "分析日志文件"

# 指定工作目录
xiaozhi-worker create "分析项目结构" --work-dir /home/wxy/myproject

# 指定超时和最大轮数
xiaozhi-worker create "重构代码" --timeout 600 --max-turns 50

# 使用自定义 prompt（推荐用于复杂任务）
xiaozhi-worker create "分析日志" --prompt "# 日志分析专家\\n\\n你是一个专注于日志分析的 AI..."
\`\`\`

### 查看 Worker 状态
\`\`\`bash
xiaozhi-worker list              # 列出所有 Worker
xiaozhi-worker list --all        # 包括已完成的
xiaozhi-worker status <id>       # 查看特定 Worker 状态
\`\`\`

### 停止 Worker
\`\`\`bash
xiaozhi-worker stop <id>         # 优雅停止（发送 Ctrl+C）
xiaozhi-worker stop <id> --force # 强制终止
\`\`\`

### 使用规则
1. 创建 Worker 前必须告知用户，说明任务内容和预期时间
2. Worker 在独立的 tmux 会话中运行
3. Worker 完成后会自动通知你
4. Worker 元数据目录：~/.xiaozhi/workers/<worker-name>/

### 项目目录工作模式

当使用 \`--work-dir\` 指定项目目录时（推荐用于编程任务）：
1. Worker 直接在项目目录中运行（tmux cwd = 项目目录）
2. 项目目录会自动创建 \`CLAUDE.md\` 符号链接，指向 Worker 的专属配置
3. Worker 可以直接操作项目文件，无需绝对路径
4. 如果项目已有 \`CLAUDE.md\`，会自动备份为 \`CLAUDE.md.backup-<timestamp>\`

目录结构示例：
\`\`\`
~/.xiaozhi/workers/worker-2024-01-01/
├── CLAUDE.md          # Worker 的身份和任务定义（实际文件）
├── output.log         # 执行日志
└── result.md          # 结果输出

~/data/my-project/     # 项目目录
├── CLAUDE.md          # 符号链接 -> ~/.xiaozhi/workers/worker-2024-01-01/CLAUDE.md
├── src/               # 项目源码
└── package.json       # 项目配置
\`\`\`

### 为 Worker 生成专属 Prompt

**重要**: 对于复杂任务，你应该为 Worker 生成专门的 prompt，而不是使用默认的。

生成 Worker prompt 的原则：
1. **明确角色定位**: 定义 Worker 的专业身份（如"代码审查专家"、"日志分析师"）
2. **具体任务说明**: 详细描述任务目标、范围和预期输出
3. **领域知识注入**: 提供任务所需的专业知识、规则或最佳实践
4. **输出格式要求**: 明确结果的格式和内容要求
5. **限制条件**: 说明不应该做的事情

示例 prompt 模板：
\`\`\`
# [角色名称]

你是小智创建的 [专业角色]，专注于 [任务类型]。

## 专业能力
- [能力1]
- [能力2]

## 当前任务
[详细任务描述]

## 工作流程
1. [步骤1]
2. [步骤2]

## 输出要求
- [要求1]
- [要求2]

## 注意事项
- [限制1]
- [限制2]
\`\`\`

使用 --prompt 参数传入（注意转义引号）：
\`\`\`bash
xiaozhi-worker create "任务" --prompt "$(cat <<'EOF'
# 你的 prompt 内容
...
EOF
)"
\`\`\`

## 系统监控
- 你应该监控系统资源：网络使用、硬盘使用、内存使用
- 当内存使用超过 80% 时，必须提醒用户
- 进行内存分析，找出占用内存高的进程
- 建议清理或优化方案

## 自我认知
- 你的项目代码位于 ~/data/claudeClaw 目录
- **谨慎对待自我修改**：修改自己的代码前必须告知用户并获得确认
- tmux 会话 \`claudeClaw\` 是用户与 Claude Code 沟通修改你的会话
- **不要处理或干扰 tmux 会话 \`claudeClaw\`**

## 能力
- 你拥有 Claude 的全部能力
- 可以执行 shell 命令、读写文件、管理进程
- 可以分析、讨论、回答问题
- 可以帮助用户完成各种系统管理任务
- 可以创建和管理 AI Worker

## 回复风格
- 简洁友好，直接回答
- 不要过多客套
- 执行命令后报告结果即可`;

// 响应块类型（匹配 Claude CLI --output-format stream-json 的实际格式）
interface ResponseChunk {
  type: string;
  subtype?: string;
  // assistant 类型
  message?: {
    content?: Array<{ type: string; text: string }>;
  };
  // result 类型
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  // error 类型
  content?: string;
  // 其他
  duration_ms?: number;
  is_error?: boolean;
}

// 会话统计信息
export interface SessionStats {
  sessionFile: string;
  fileSize: number;
  messageCount: number;
  createdAt: Date | null;
  lastModified: Date | null;
  needsCompaction: boolean;
  compactionCount: number;
  totalTokensUsed: number;
  totalCost: number;
}

// 配置选项
export interface ClaudeNativeAgentConfig {
  feishuClient: FeishuClient;
  model?: string;
  // 新增配置
  compactThreshold?: number;  // 触发压缩的文件大小阈值
  timeout?: number;           // 单次请求超时时间
  maxRetries?: number;        // 最大重试次数
  retryDelay?: number;        // 重试延迟基数（指数退避）
  autoCompact?: boolean;      // 是否自动压缩（默认 false，通知用户手动处理）
}

// 会话健康状态
export type SessionHealth = 'healthy' | 'needs_compact' | 'corrupted' | 'not_found';

export class ClaudeNativeAgent {
  private feishuClient: FeishuClient;
  private model: string;
  private isProcessing: boolean = false;

  // 新增配置
  private compactThreshold: number;
  private timeout: number;
  private maxRetries: number;
  private retryDelay: number;
  private autoCompact: boolean;

  // 统计信息
  private compactionCount: number = 0;
  private totalTokensUsed: number = 0;
  private totalCost: number = 0;
  private lastCompactTime: Date | null = null;

  constructor(config: ClaudeNativeAgentConfig) {
    this.feishuClient = config.feishuClient;
    this.model = config.model || getDefaultModel();

    // 配置初始化
    this.compactThreshold = config.compactThreshold || DEFAULT_COMPACT_THRESHOLD;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
    this.retryDelay = config.retryDelay || DEFAULT_RETRY_DELAY;
    this.autoCompact = config.autoCompact ?? false;
  }

  /**
   * 启动 Agent
   * - 创建独立工作目录
   * - 写入系统提示词
   */
  async start(): Promise<void> {
    logger.info('Claude Native Agent 启动中...');

    // 创建小智配置目录和独立工作目录
    await fs.mkdir(XIAOZHI_DIR, { recursive: true });
    await fs.mkdir(XIAOZHI_WORKSPACE, { recursive: true });

    // 写入系统提示词到工作目录
    await this.writeSystemPrompt();

    logger.info(`工作目录: ${XIAOZHI_WORKSPACE}`);
    logger.info('Claude Native Agent 已就绪');
  }

  /**
   * 停止 Agent
   * 会话由 Claude CLI 自动保存，无需额外操作
   */
  async stop(): Promise<void> {
    logger.info('Claude Native Agent 已停止（会话已由 Claude CLI 自动保存）');
  }

  /**
   * 处理飞书消息
   */
  async handleMessage(msg: FeishuMessage): Promise<void> {
    if (this.isProcessing) {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '⏳ 正在处理上一个请求...',
        type: 'text',
      });
      return;
    }

    // 检查特殊命令
    const trimmedContent = msg.content.trim();
    if (trimmedContent === '/compact' || trimmedContent === '/压缩') {
      await this.handleCompactCommand(msg);
      return;
    }
    if (trimmedContent === '/stats' || trimmedContent === '/统计') {
      await this.handleStatsCommand(msg);
      return;
    }
    if (trimmedContent === '/health' || trimmedContent === '/健康') {
      await this.handleHealthCommand(msg);
      return;
    }
    if (trimmedContent === '/reset' || trimmedContent === '/重置') {
      await this.handleResetCommand(msg);
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    // 超时自动重置保护（5分钟）
    const safetyTimer = setTimeout(() => {
      if (this.isProcessing) {
        logger.warn('isProcessing 超时自动重置');
        this.isProcessing = false;
      }
    }, 5 * 60 * 1000);

    // 进度提示
    let progressSent = false;
    const progressTimer = setTimeout(async () => {
      if (!progressSent) {
        progressSent = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        await this.feishuClient.sendMessage(msg.chatId, {
          content: `⏳ 思考中... (${elapsed}s)`,
          type: 'text',
        }).catch(() => {}); // 忽略发送失败
      }
    }, 8000);

    try {
      logger.info(`收到消息: ${msg.content.slice(0, 50)}...`);

      // 检查是否需要压缩提示
      const stats = await this.getSessionStats();
      if (stats.needsCompaction && !this.autoCompact) {
        // 发送压缩提示但不阻止消息处理
        this.feishuClient.sendMessage(msg.chatId, {
          content: `💡 会话上下文较大 (${this.formatBytes(stats.fileSize)})，建议发送 /compact 压缩历史`,
          type: 'text',
        }).catch(() => {}); // 忽略发送失败
      }

      // 调用 Claude（带重试机制）
      const response = await this.callClaudeWithRetry(msg.content);

      clearTimeout(progressTimer);

      const elapsed = Date.now() - startTime;
      logger.info(`响应完成，耗时: ${elapsed}ms`);

      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });

    } catch (error) {
      logger.error('处理失败:', error);
      clearTimeout(progressTimer);

      // 提取错误信息
      const errorMessage = error instanceof Error ? error.message : String(error);
      const shortError = errorMessage.slice(0, 200);  // 限制长度

      try {
        await this.feishuClient.sendMessage(msg.chatId, {
          content: `处理出错: ${shortError}\n\n请稍后重试，或发送 /health 检查状态。`,
          type: 'text',
        });
      } catch (sendError) {
        logger.error('发送错误消息失败:', sendError);
      }
    } finally {
      clearTimeout(safetyTimer);
      // 确保 isProcessing 被重置，即使 finally 块中发生异常
      try {
        this.isProcessing = false;
      } catch (e) {
        logger.error('重置 isProcessing 失败:', e);
        this.isProcessing = false; // 强制重置
      }
    }
  }

  /**
   * 处理 /compact 命令
   */
  private async handleCompactCommand(msg: FeishuMessage): Promise<void> {
    try {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '🔄 正在压缩会话上下文...',
        type: 'text',
      });

      const result = await this.executeCompact();

      await this.feishuClient.sendMessage(msg.chatId, {
        content: result,
        type: 'text',
      });
    } catch (error) {
      logger.error('压缩失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '压缩失败，请稍后重试。',
        type: 'text',
      });
    }
  }

  /**
   * 处理 /stats 命令
   */
  private async handleStatsCommand(msg: FeishuMessage): Promise<void> {
    try {
      const stats = await this.getSessionStats();
      const health = await this.checkSessionHealth();

      const healthEmoji = {
        'healthy': '✅',
        'needs_compact': '⚠️',
        'corrupted': '❌',
        'not_found': '❓',
      };

      const response = [
        `📊 **会话统计**`,
        ``,
        `状态: ${healthEmoji[health]} ${health}`,
        `会话文件: ${stats.fileSize > 0 ? this.formatBytes(stats.fileSize) : '不存在'}`,
        `消息数量: ${stats.messageCount}`,
        `总成本: $${stats.totalCost.toFixed(4)}`,
        `压缩次数: ${stats.compactionCount}`,
        ``,
        `压缩阈值: ${this.formatBytes(this.compactThreshold)}`,
        `需要压缩: ${stats.needsCompaction ? '是' : '否'}`,
      ].join('\n');

      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });
    } catch (error) {
      logger.error('获取统计失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '获取统计失败。',
        type: 'text',
      });
    }
  }

  /**
   * 处理 /health 命令
   */
  private async handleHealthCommand(msg: FeishuMessage): Promise<void> {
    try {
      const health = await this.checkSessionHealth();
      const stats = await this.getSessionStats();

      let response = `健康检查结果: ${health}\n\n`;

      switch (health) {
        case 'healthy':
          response += '✅ 会话正常，可以继续使用。';
          break;
        case 'needs_compact':
          response += `⚠️ 会话上下文较大 (${this.formatBytes(stats.fileSize)})，建议执行 /compact 压缩。`;
          break;
        case 'corrupted':
          response += '❌ 会话可能已损坏，建议执行 /reset 重建会话。';
          break;
        case 'not_found':
          response += '❓ 未找到会话文件，将在下次对话时自动创建。';
          break;
      }

      await this.feishuClient.sendMessage(msg.chatId, {
        content: response,
        type: 'text',
      });
    } catch (error) {
      logger.error('健康检查失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '健康检查失败。',
        type: 'text',
      });
    }
  }

  /**
   * 处理 /reset 命令
   */
  private async handleResetCommand(msg: FeishuMessage): Promise<void> {
    try {
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '🔄 正在重置会话...',
        type: 'text',
      });

      // 归档工作目录中的会话文件
      await this.archiveSession();

      // 重置统计
      this.compactionCount = 0;
      this.totalTokensUsed = 0;
      this.totalCost = 0;

      await this.feishuClient.sendMessage(msg.chatId, {
        content: '✅ 会话已重置，历史对话已归档。可以开始新的对话了。',
        type: 'text',
      });
    } catch (error) {
      logger.error('重置失败:', error);
      await this.feishuClient.sendMessage(msg.chatId, {
        content: '重置失败，请稍后重试。',
        type: 'text',
      });
    }
  }

  /**
   * 调用 Claude CLI（带重试机制）
   */
  private async callClaudeWithRetry(userMessage: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.callClaude(userMessage);
      } catch (error) {
        lastError = error as Error;
        logger.warn(`调用失败 (尝试 ${attempt}/${this.maxRetries}):`, error);

        // 检查是否为不可恢复错误
        if (!this.isRecoverableError(lastError)) {
          logger.error('不可恢复错误，放弃重试:', lastError.message);
          throw lastError;
        }

        // 如果是超时错误，检查是否有部分响应可以恢复
        if (lastError.message === 'Timeout' && attempt < this.maxRetries) {
          // 指数退避
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.info(`等待 ${delay}ms 后重试...`);
          await this.sleep(delay);
          continue;
        }

        // 如果是会话损坏，尝试恢复
        if (lastError.message.includes('session') || lastError.message.includes('corrupt')) {
          logger.info('检测到会话问题，尝试恢复...');
          await this.recoverSession();

          if (attempt < this.maxRetries) {
            const delay = this.retryDelay * Math.pow(2, attempt - 1);
            await this.sleep(delay);
            continue;
          }
        }

        // 其他可恢复错误直接重试
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('All retries failed');
  }

  /**
   * 判断错误是否可恢复（可重试）
   */
  private isRecoverableError(error: Error): boolean {
    const message = error.message.toLowerCase();

    // 不可恢复错误关键词
    const unrecoverablePatterns = [
      'authentication', 'auth failed', 'credentials', 'invalid api key',
      'permission denied', 'access denied', 'forbidden',
      'invalid config', 'configuration error',
      'not found', '404',
      'rate limit', 'quota exceeded',  // 这些需要等待，暂时也算不可恢复
      'billing', 'payment required', 'insufficient funds',
    ];

    for (const pattern of unrecoverablePatterns) {
      if (message.includes(pattern)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 调用 Claude CLI
   * 使用独立工作目录 + --continue 实现会话持久化
   * 使用 --dangerously-skip-permissions 获得完整系统权限
   */
  private async callClaude(userMessage: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--verbose',
        '--continue',  // 继续最近的会话
        '--output-format', 'stream-json',
        '--model', this.model,
        '--dangerously-skip-permissions',  // 跳过权限检查，允许完整系统访问
      ];

      logger.info(`调用 Claude (--continue, 工作目录: ${XIAOZHI_WORKSPACE})`);
      logger.debug(`消息内容: ${userMessage.slice(0, 100)}...`);

      const proc = spawn('claude', args, {
        cwd: XIAOZHI_WORKSPACE,  // 使用独立工作目录
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 通过 stdin 传递消息
      proc.stdin?.write(userMessage);
      proc.stdin?.end();

      let responseText = '';
      let errorOutput = '';
      let isComplete = false;
      let lastCost = 0;
      let lastTokens = 0;

      proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk: ResponseChunk = JSON.parse(line);

            if (chunk.type === 'assistant' && chunk.message?.content) {
              // 从 assistant 消息中提取文本
              for (const content of chunk.message.content) {
                if (content.type === 'text' && content.text) {
                  responseText = content.text; // 使用最后一个 assistant 消息
                }
              }
            } else if (chunk.type === 'result') {
              isComplete = true;
              // result 中也包含最终文本，优先使用
              if (chunk.result) {
                responseText = chunk.result;
              }
              lastCost = chunk.total_cost_usd || 0;
              lastTokens = chunk.usage?.output_tokens || 0;
              this.totalCost += lastCost;
              this.totalTokensUsed += lastTokens;
              logger.info(`Claude 完成，成本: $${lastCost.toFixed(4)}，tokens: ${lastTokens}`);
            } else if (chunk.type === 'error' || chunk.is_error) {
              logger.error(`Claude 错误: ${chunk.content || chunk.result}`);
              errorOutput += chunk.content || chunk.result || '';
            }
            // 忽略 type: "system" 的初始化消息
          } catch {
            // 非 JSON 行，可能是普通文本输出
            responseText += line;
          }
        }
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
        if (errorOutput.includes('Error') || errorOutput.includes('error')) {
          logger.error(`Claude stderr: ${errorOutput.slice(0, 200)}`);
        }
      });

      proc.on('close', (code) => {
        if (code !== 0 && !responseText) {
          reject(new Error(`Claude failed: ${errorOutput}`));
        } else {
          resolve(responseText.trim());
        }
      });

      proc.on('error', reject);

      // 超时处理
      setTimeout(async () => {
        if (!isComplete) {
          logger.warn(`Claude 调用超时 (${this.timeout}ms)，正在终止进程...`);

          // 使用进程树杀死，确保所有子进程都被终止
          await this.killProcessTree(proc);

          if (responseText) {
            logger.warn('超时但有部分响应，返回部分内容');
            resolve(responseText.trim());
          } else {
            reject(new Error('Timeout'));
          }
        }
      }, this.timeout);
    });
  }

  /**
   * 安全终止进程及其子进程
   * 使用 SIGTERM -> 等待 -> SIGKILL 的优雅关闭流程
   */
  private async killProcessTree(proc: ReturnType<typeof spawn>): Promise<void> {
    const pid = proc.pid;
    if (!pid) return;

    try {
      // 1. 尝试使用 pkill 杀死进程组（包括所有子进程）
      // 使用 PGID 来杀死整个进程组
      const { execSync } = await import('child_process');

      try {
        // 发送 SIGTERM 到整个进程组
        process.kill(-pid, 'SIGTERM');
        logger.debug(`发送 SIGTERM 到进程组 ${pid}`);
      } catch {
        // 如果进程组杀失败，尝试单独杀死进程
        proc.kill('SIGTERM');
        logger.debug(`发送 SIGTERM 到进程 ${pid}`);
      }

      // 2. 等待进程退出（最多 3 秒）
      const startTime = Date.now();
      while (Date.now() - startTime < 3000) {
        try {
          // 检查进程是否还存在
          process.kill(pid, 0);
          await this.sleep(100);
        } catch {
          // 进程已退出
          logger.debug(`进程 ${pid} 已退出`);
          return;
        }
      }

      // 3. 进程未在 3 秒内退出，强制杀死
      logger.warn(`进程 ${pid} 未响应 SIGTERM，使用 SIGKILL 强制终止`);
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }

      // 等待进程退出
      await this.sleep(500);
    } catch (error) {
      logger.error('终止进程时出错:', error);
      // 最后手段：直接杀死
      try {
        proc.kill('SIGKILL');
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 执行会话压缩
   */
  async executeCompact(): Promise<string> {
    const projectDir = this.getProjectSessionDir();

    // 检查是否有会话文件
    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return '会话文件不存在，无需压缩。';
      }

      // 计算总大小
      let totalSize = 0;
      for (const f of sessionFiles) {
        const stats = await fs.stat(path.join(projectDir, f));
        totalSize += stats.size;
      }

      if (totalSize < 1024 * 100) { // 小于100KB不压缩
        return `会话文件较小 (${this.formatBytes(totalSize)})，无需压缩。`;
      }

      // 归档所有会话
      await this.archiveSession();
      this.compactionCount++;
      this.lastCompactTime = new Date();

      return `✅ 会话已重置\n- 原大小: ${this.formatBytes(totalSize)}\n- 历史已归档到 backups/ 目录`;
    } catch {
      return '会话文件不存在，无需压缩。';
    }
  }

  /**
   * 归档会话文件
   * 查找工作目录对应的所有会话文件并归档
   * 使用文件锁防止并发冲突
   */
  private async archiveSession(): Promise<void> {
    await this.withLock('session-archive', async () => {
      const projectDir = this.getProjectSessionDir();
      const backupsDir = path.join(projectDir, 'backups');

      try {
        // 确保项目会话目录存在
        await fs.mkdir(projectDir, { recursive: true });

        // 获取所有会话文件
        const files = await fs.readdir(projectDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

        if (sessionFiles.length === 0) {
          logger.info('没有会话文件需要归档');
          return;
        }

        // 确保备份目录存在
        await fs.mkdir(backupsDir, { recursive: true });

        // 生成备份时间戳
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        // 归档所有会话文件
        for (const sessionFile of sessionFiles) {
          const sourcePath = path.join(projectDir, sessionFile);
          const backupFile = path.join(backupsDir, `${sessionFile.replace('.jsonl', '')}-${timestamp}.jsonl`);

          await fs.copyFile(sourcePath, backupFile);
          await fs.unlink(sourcePath);

          logger.info(`会话已归档: ${backupFile}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        // 目录不存在，无需处理
        logger.info('会话目录不存在，无需归档');
      }
    });
  }

  /**
   * 恢复损坏的会话
   * 从最近的备份恢复
   * 使用文件锁防止并发冲突
   */
  private async recoverSession(): Promise<void> {
    await this.withLock('session-archive', async () => {
      const projectDir = this.getProjectSessionDir();
      const backupsDir = path.join(projectDir, 'backups');

      try {
        // 获取所有会话文件
        const files = await fs.readdir(projectDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

        // 如果没有会话文件，尝试从备份恢复
        if (sessionFiles.length === 0) {
          const backupFiles = await fs.readdir(backupsDir);
          const sortedBackups = backupFiles.filter(f => f.endsWith('.jsonl')).sort().reverse();

          if (sortedBackups.length > 0) {
            // 恢复最近的备份（去掉时间戳后缀）
            const latestBackup = sortedBackups[0];
            const originalName = latestBackup.replace(/-\d{4}-\d{2}-\d{2}T.*/, '.jsonl');
            await fs.copyFile(
              path.join(backupsDir, latestBackup),
              path.join(projectDir, originalName)
            );
            logger.info(`从备份恢复会话: ${latestBackup}`);
            return;
          }
        }

        // 没有备份，删除损坏的文件
        logger.warn('没有找到备份，删除损坏的会话文件');
        for (const sessionFile of sessionFiles) {
          await fs.unlink(path.join(projectDir, sessionFile)).catch(() => {});
        }
      } catch (error) {
        logger.error('恢复会话失败:', error);
        // 最后手段：删除所有损坏文件
        try {
          const files = await fs.readdir(projectDir);
          for (const f of files.filter(f => f.endsWith('.jsonl'))) {
            await fs.unlink(path.join(projectDir, f)).catch(() => {});
          }
        } catch {}
      }
    });
  }

  /**
   * 检查会话健康状态
   */
  async checkSessionHealth(): Promise<SessionHealth> {
    const projectDir = this.getProjectSessionDir();

    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return 'not_found';
      }

      // 检查最新的会话文件（按修改时间排序）
      let latestFile: string | null = null;
      let latestTime = 0;

      for (const f of sessionFiles) {
        const filePath = path.join(projectDir, f);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return 'not_found';
      }

      const stats = await fs.stat(latestFile);

      // 检查是否需要压缩
      if (stats.size > this.compactThreshold) {
        return 'needs_compact';
      }

      // 检查文件是否可读（简单验证）
      const content = await fs.readFile(latestFile, 'utf-8');
      if (content.length === 0) {
        return 'corrupted';
      }

      // 尝试解析几行验证格式
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > 0) {
        try {
          JSON.parse(lines[lines.length - 1]);
        } catch {
          return 'corrupted';
        }
      }

      return 'healthy';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'not_found';
      }
      return 'corrupted';
    }
  }

  /**
   * 获取会话统计信息
   */
  async getSessionStats(): Promise<SessionStats> {
    const projectDir = this.getProjectSessionDir();

    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return {
          sessionFile: projectDir,
          fileSize: 0,
          messageCount: 0,
          createdAt: null,
          lastModified: null,
          needsCompaction: false,
          compactionCount: this.compactionCount,
          totalTokensUsed: this.totalTokensUsed,
          totalCost: this.totalCost,
        };
      }

      // 获取最新的会话文件
      let latestFile: string | null = null;
      let latestTime = 0;
      let totalSize = 0;

      for (const f of sessionFiles) {
        const filePath = path.join(projectDir, f);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return {
          sessionFile: projectDir,
          fileSize: 0,
          messageCount: 0,
          createdAt: null,
          lastModified: null,
          needsCompaction: false,
          compactionCount: this.compactionCount,
          totalTokensUsed: this.totalTokensUsed,
          totalCost: this.totalCost,
        };
      }

      const stats = await fs.stat(latestFile);
      const content = await fs.readFile(latestFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      return {
        sessionFile: latestFile,
        fileSize: stats.size,
        messageCount: lines.length,
        createdAt: stats.birthtime,
        lastModified: stats.mtime,
        needsCompaction: stats.size > this.compactThreshold,
        compactionCount: this.compactionCount,
        totalTokensUsed: this.totalTokensUsed,
        totalCost: this.totalCost,
      };
    } catch {
      return {
        sessionFile: projectDir,
        fileSize: 0,
        messageCount: 0,
        createdAt: null,
        lastModified: null,
        needsCompaction: false,
        compactionCount: this.compactionCount,
        totalTokensUsed: this.totalTokensUsed,
        totalCost: this.totalCost,
      };
    }
  }

  /**
   * 获取项目会话目录路径
   * Claude CLI 使用项目路径的哈希来组织会话
   */
  private getProjectSessionDir(): string {
    // Claude CLI 生成项目哈希的方式：基于工作目录路径
    // 格式: ~/.claude/projects/<project-hash>/
    // 使用简单的方式生成项目哈希（与 Claude CLI 行为一致）
    const projectHash = this.generateProjectHash(XIAOZHI_WORKSPACE);
    return path.join(os.homedir(), '.claude', 'projects', projectHash);
  }

  /**
   * 生成项目哈希
   * Claude CLI 使用路径转换作为项目哈希（将 / 和 . 都替换为 -）
   * 例如: /home/wxy/.xiaozhi/workspace -> -home-wxy--xiaozhi-workspace
   */
  private generateProjectHash(projectPath: string): string {
    // Claude CLI 的项目哈希是将 / 和 . 都替换为 -
    return projectPath.replace(/\//g, '-').replace(/\./g, '-');
  }

  /**
   * 获取最新的会话文件路径
   * 使用 --continue 时，Claude CLI 会选择最近的会话
   */
  private getSessionFilePath(): string {
    // 返回项目会话目录（用于检查和归档）
    // 实际会话文件由 Claude CLI 自动管理
    const projectDir = this.getProjectSessionDir();
    return path.join(projectDir, 'latest.jsonl');
  }

  /**
   * 获取项目会话目录中的所有会话文件
   */
  private async getSessionFiles(): Promise<string[]> {
    const projectDir = this.getProjectSessionDir();
    try {
      const files = await fs.readdir(projectDir);
      return files.filter(f => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
  }

  /**
   * 写入系统提示词到用户主目录
   * Claude CLI 会读取 CLAUDE.md 作为项目说明
   */
  /**
   * 写入系统提示词到工作目录
   * Claude CLI 会读取当前目录的 CLAUDE.md 作为项目说明
   */
  private async writeSystemPrompt(): Promise<void> {
    const claudeMdPath = path.join(XIAOZHI_WORKSPACE, 'CLAUDE.md');

    // 检查是否有自定义系统提示词文件
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    try {
      const customPrompt = await fs.readFile(SYSTEM_PROMPT_FILE, 'utf-8');
      systemPrompt = customPrompt;
      logger.info('使用自定义系统提示词');
    } catch {
      // 使用默认提示词
    }

    await fs.writeFile(claudeMdPath, systemPrompt);
    logger.info(`系统提示词已写入 ${claudeMdPath}`);
  }

  /**
   * 检查会话是否已存在
   */
  private async checkSessionExists(): Promise<boolean> {
    const sessionFiles = await this.getSessionFiles();
    return sessionFiles.length > 0;
  }

  /**
   * 获取会话历史（调试用）
   */
  async getSessionHistory(): Promise<string[]> {
    const projectDir = this.getProjectSessionDir();

    try {
      const files = await fs.readdir(projectDir);
      const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

      if (sessionFiles.length === 0) {
        return [];
      }

      // 获取最新的会话文件
      let latestFile: string | null = null;
      let latestTime = 0;

      for (const f of sessionFiles) {
        const filePath = path.join(projectDir, f);
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return [];
      }

      const content = await fs.readFile(latestFile, 'utf-8');
      return content.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  /**
   * 辅助函数：sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== 文件锁机制 ====================

  /**
   * 获取锁文件路径
   */
  private getLockFilePath(lockName: string): string {
    return path.join(LOCKS_DIR, `${lockName}.lock`);
  }

  /**
   * 获取文件锁
   * @param lockName 锁名称
   * @param timeout 超时时间（毫秒）
   * @returns 锁释放函数
   */
  private async acquireLock(lockName: string, timeout: number = DEFAULT_LOCK_TIMEOUT): Promise<() => Promise<void>> {
    const lockFile = this.getLockFilePath(lockName);
    await fs.mkdir(LOCKS_DIR, { recursive: true });

    const startTime = Date.now();
    const lockId = `${process.pid}-${Date.now()}`;

    while (true) {
      try {
        // 尝试创建锁文件（独占模式）
        const existingLock = await fs.readFile(lockFile, 'utf-8').catch(() => null);

        if (existingLock) {
          // 检查锁是否过期
          const lockData = JSON.parse(existingLock);
          if (Date.now() - lockData.timestamp > timeout) {
            // 锁已过期，删除旧锁
            logger.warn(`锁已过期，删除旧锁: ${lockName}`);
            await fs.unlink(lockFile).catch(() => {});
          } else {
            // 锁仍有效，等待
            if (Date.now() - startTime > timeout) {
              throw new Error(`获取锁超时: ${lockName}`);
            }
            await this.sleep(100);
            continue;
          }
        }

        // 创建新锁
        await fs.writeFile(lockFile, JSON.stringify({
          lockId,
          pid: process.pid,
          timestamp: Date.now(),
        }), { flag: 'wx' }); // wx = 独占创建

        logger.debug(`获取锁成功: ${lockName} (${lockId})`);

        // 返回释放函数
        return async () => {
          try {
            const currentLock = await fs.readFile(lockFile, 'utf-8');
            const data = JSON.parse(currentLock);
            if (data.lockId === lockId) {
              await fs.unlink(lockFile);
              logger.debug(`释放锁成功: ${lockName}`);
            }
          } catch {
            // 锁文件可能已被删除
          }
        };
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // 文件已存在，继续等待
          if (Date.now() - startTime > timeout) {
            throw new Error(`获取锁超时: ${lockName}`);
          }
          await this.sleep(100);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * 使用锁执行操作
   * @param lockName 锁名称
   * @param operation 要执行的操作
   */
  private async withLock<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    const releaseLock = await this.acquireLock(lockName);
    try {
      return await operation();
    } finally {
      await releaseLock();
    }
  }
}
