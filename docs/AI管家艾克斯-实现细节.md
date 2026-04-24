# AI管家艾克斯 - 技术实现细节

## 1. Claude CLI 作为 AI Worker 的能力分析

### 1.1 Claude CLI 现有特性
Claude Code CLI 提供了完整的命令行接口，非常适合作为Worker运行：

| 能力 | CLI支持 | 使用方式 |
|------|--------|---------|
| 非交互模式 | ✅ `--print` 或 `-p` | `claude -p "任务描述"` |
| 会话恢复 | ✅ `--resume` 或 `-r` | `claude -r <session_id>` |
| 会话ID指定 | ✅ `--session-id` | `claude --session-id <uuid>` |
| 工作目录 | ✅ `--add-dir` | `claude --add-dir /path/to/project` |
| 权限跳过 | ✅ `--dangerously-skip-permissions` | Worker模式推荐 |
| 输出格式 | ✅ `--output-format` | `json` 或 `stream-json` |
| 最大轮数 | ✅ `--max-turns` | 限制执行轮数 |
| 模型选择 | ✅ `--model` | `sonnet`, `opus`, `haiku` |

### 1.2 Worker 模式启动命令

```bash
# 基础Worker启动
claude --print \
       --session-id "worker_${WORKER_ID}" \
       --dangerously-skip-permissions \
       --add-dir "${WORK_DIR}" \
       --settings "${WORKER_DIR}/.claude/settings.json" \
       "任务描述..."

# 带进度输出的Worker（stream模式）
claude --print \
       --output-format stream-json \
       --session-id "worker_${WORKER_ID}" \
       --dangerously-skip-permissions \
       "任务描述..." 2>&1 | tee "${WORKER_DIR}/output.log"

# 限制资源的Worker
claude --print \
       --session-id "worker_${WORKER_ID}" \
       --max-turns 50 \
       --max-budget-usd 5.00 \
       "任务描述..."
```

### 1.3 Claude Hooks 配置详解

**Worker专用Hooks配置文件** (`.claude/settings.json`):

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/var/lib/xdev/scripts/notify_xdev.sh ${XDEV_WORKER_ID}"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/var/lib/xdev/scripts/worker_completed.sh ${XDEV_WORKER_ID}"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/var/lib/xdev/scripts/subagent_notify.sh ${XDEV_WORKER_ID}"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_name' >> /var/lib/xdev/workers/${XDEV_WORKER_ID}/actions.log"
          }
        ]
      }
    ]
  }
}
```

**Hook事件数据格式**:

```typescript
// Notification事件数据
interface NotificationHookData {
  session_id: string;
  notification: string;
  reason: string;  // 'user_input_required' | 'permission_required' 等
  timestamp: string;
}

// Stop事件数据
interface StopHookData {
  session_id: string;
  result: string;
  cost_usd: number;
  duration_ms: number;
  timestamp: string;
}

// SubagentStop事件数据
interface SubagentStopHookData {
  session_id: string;
  parent_session_id: string;
  subagent_type: string;
  result: string;
  timestamp: string;
}

// PostToolUse事件数据
interface PostToolUseHookData {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, any>;
  tool_result: string;
  timestamp: string;
}
```

### 1.4 Claude CLI Agent模式（通过SDK调用）

对于需要程序化控制的场景，可以使用Agent SDK：

```typescript
import { ClaudeSDK } from '@anthropic/claude-sdk';

// 方式1: 使用claude命令的-p模式（推荐用于Worker）
async function runWorkerWithClaudeCLI(
  workerId: string,
  taskDescription: string,
  workDir: string
): Promise<string> {
  const result = await ClaudeSDK.query({
    prompt: taskDescription,
    options: {
      model: 'claude-sonnet-4-5-20250929',
      sessionId: workerId,
      workDir: workDir,
      skipPermissions: true,
      outputStream: process.stdout,  // 实时输出
    },
  });

  return result;
}

// 方式2: 直接使用Claude Agent
import { ClaudeAgent } from '@anthropic/claude-agent-sdk';

const workerAgent = new ClaudeAgent({
  model: 'claude-sonnet-4-5-20250929',
  systemPrompt: `你是一个专门执行特定任务的Claude Worker。
任务完成后，输出一个结构化的结果报告。`,
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
});

const result = await workerAgent.execute(taskDescription);
```

## 2. AI管家艾克斯核心实现

### 2.1 项目结构（TypeScript）

```
xdev/
├── src/
│   ├── index.ts                    # 入口文件
│   ├── core/
│   │   ├── xdev.ts              # 艾克斯主服务
│   │   ├── agent.ts                # Claude Agent封装
│   │   └── message-handler.ts      # 消息处理器
│   ├── session/
│   │   ├── manager.ts              # 会话管理器
│   │   ├── store.ts                # 会话存储
│   │   └── types.ts                # 类型定义
│   ├── worker/
│   │   ├── manager.ts              # Worker管理器
│   │   ├── factory.ts              # Worker工厂
│   │   ├── monitor.ts              # 状态监控
│   │   └── hooks-receiver.ts       # Hooks接收器
│   ├── feishu/
│   │   ├── client.ts               # 飞书客户端
│   │   ├── adapter.ts              # 消息适配器
│   │   └── card-builder.ts         # 消息卡片构建器
│   ├── storage/
│   │   ├── sqlite.ts               # SQLite存储
│   │   └── redis.ts                # Redis客户端（可选）
│   └── utils/
│       ├── tmux.ts                 # tmux工具
│       └── logger.ts               # 日志工具
├── scripts/
│   ├── notify_xdev.sh           # Hook通知脚本
│   ├── worker_completed.sh         # Worker完成脚本
│   └── subagent_notify.sh          # 子代理通知脚本
├── config/
│   └── config.yaml                 # 配置文件
├── package.json
└── tsconfig.json
```

### 2.2 核心类型定义

```typescript
// src/session/types.ts
export interface Session {
  id: string;
  name: string;
  userId: string;
  feishuChatId: string;
  status: SessionStatus;
  context: SessionContext;
  settings: SessionSettings;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionStatus = 'active' | 'archived' | 'deleted';

export interface SessionContext {
  conversationHistory: Message[];
  activeWorkers: string[];
  taskContext: Record<string, any>;
  summary?: string;  // 历史对话摘要
}

export interface SessionSettings {
  notifyOnProgress: boolean;
  progressNotifyInterval: number;  // 秒
  maxWorkers: number;
  defaultTimeout: number;  // 秒
}

// src/worker/types.ts
export interface ClaudeWorker {
  id: string;
  name: string;
  sessionId: string;
  status: WorkerStatus;
  tmuxSession: string;
  claudeSessionId: string;
  task: WorkerTask;
  progress: WorkerProgress;
  result?: WorkerResult;
  hooks: WorkerHooks;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export type WorkerStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'timeout';

export interface WorkerTask {
  description: string;
  workDir: string;
  model: 'sonnet' | 'opus' | 'haiku';
  timeout?: number;
  maxTurns?: number;
  maxBudget?: number;
}

export interface WorkerProgress {
  percentage: number;
  currentStep: string;
  toolCalls: number;
  filesModified: number;
  lastUpdate: Date;
  eta?: number;
}

export interface WorkerResult {
  success: boolean;
  summary: string;
  details?: string;
  artifacts?: string[];  // 生成的文件路径
  cost: number;
  duration: number;
}

export interface WorkerHooks {
  progressFile: string;
  notifyScript: string;
  completedScript: string;
}

// src/feishu/types.ts
export interface FeishuMessage {
  messageId: string;
  chatId: string;
  userId: string;
  content: string;
  msgType: 'text' | 'post' | 'interactive';
  timestamp: Date;
}

export interface FeishuReply {
  content: string;
  type: 'text' | 'markdown' | 'interactive';
  card?: MessageCard;
}
```

### 2.3 艾克斯核心服务实现

```typescript
// src/core/xdev.ts
import { ClaudeAgent } from '@anthropic/claude-agent-sdk';
import { SessionManager } from '../session/manager';
import { WorkerManager } from '../worker/manager';
import { FeishuClient } from '../feishu/client';

export class XdevService {
  private agent: ClaudeAgent;
  private sessionManager: SessionManager;
  private workerManager: WorkerManager;
  private feishuClient: FeishuClient;

  constructor(config: XdevConfig) {
    // 初始化Claude Agent
    this.agent = new ClaudeAgent({
      model: 'claude-sonnet-4-5-20250929',
      systemPrompt: this.buildSystemPrompt(),
      tools: this.createTools(),
    });

    this.sessionManager = new SessionManager(config.storage);
    this.workerManager = new WorkerManager(config.worker);
    this.feishuClient = new FeishuClient(config.feishu);
  }

  private buildSystemPrompt(): string {
    return `你是AI管家艾克斯，一个智能任务管理系统。

## 你的职责
1. 通过飞书与用户沟通
2. 处理简单任务（问答、信息查询、简单操作）
3. 判断任务复杂度，必要时创建Claude Worker
4. 管理和监控Claude Worker的运行状态

## 可用工具
- spawn_worker: 创建新的Claude Worker处理复杂任务
- check_worker: 检查Worker状态和进度
- list_workers: 列出所有Worker
- terminate_worker: 终止Worker
- send_message: 发送消息到飞书

## 任务复杂度判断标准
**简单任务** (直接处理):
- 简单问答
- 信息查询
- 单文件操作
- 预计<5分钟完成

**中等任务** (询问后决定):
- 多文件修改
- 需要运行测试
- 预计5-30分钟

**复杂任务** (创建Worker):
- 大规模重构
- 多子系统操作
- 长时间运行任务
- 预计>30分钟

## 回复风格
- 简洁明了
- 使用emoji增加亲和力
- 重要信息用**加粗**
- 进度信息使用结构化格式`;
  }

  private createTools() {
    return [
      {
        name: 'spawn_worker',
        description: '创建新的Claude Worker来处理复杂任务',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Worker名称' },
            task: { type: 'string', description: '任务描述' },
            workDir: { type: 'string', description: '工作目录' },
            model: { type: 'string', enum: ['sonnet', 'opus', 'haiku'] },
          },
          required: ['task'],
        },
        handler: async (params: any) => {
          return this.workerManager.spawnWorker({
            sessionId: this.currentSessionId,
            ...params,
          });
        },
      },
      {
        name: 'check_worker',
        description: '检查指定Worker的状态和进度',
        parameters: {
          type: 'object',
          properties: {
            workerId: { type: 'string' },
          },
          required: ['workerId'],
        },
        handler: async (params: any) => {
          return this.workerManager.getStatus(params.workerId);
        },
      },
      {
        name: 'list_workers',
        description: '列出当前会话的所有Worker',
        parameters: { type: 'object', properties: {} },
        handler: async () => {
          return this.workerManager.listBySession(this.currentSessionId);
        },
      },
      {
        name: 'terminate_worker',
        description: '终止指定的Worker',
        parameters: {
          type: 'object',
          properties: {
            workerId: { type: 'string' },
            force: { type: 'boolean' },
          },
          required: ['workerId'],
        },
        handler: async (params: any) => {
          return this.workerManager.terminate(params.workerId, params.force);
        },
      },
    ];
  }

  async handleMessage(msg: FeishuMessage): Promise<void> {
    // 1. 获取或创建会话
    const session = await this.sessionManager.getOrCreate(
      msg.userId,
      msg.chatId
    );
    this.currentSessionId = session.id;

    // 2. 添加用户消息到上下文
    await this.sessionManager.addMessage(session.id, {
      role: 'user',
      content: msg.content,
    });

    // 3. 让Claude Agent处理
    const response = await this.agent.process(msg.content, {
      context: session.context,
      sessionId: session.id,
    });

    // 4. 执行工具调用
    for (const toolCall of response.toolCalls || []) {
      await this.executeToolCall(toolCall);
    }

    // 5. 发送回复到飞书
    await this.feishuClient.sendMessage(msg.chatId, {
      content: response.text,
      type: 'markdown',
    });

    // 6. 更新会话上下文
    await this.sessionManager.addMessage(session.id, {
      role: 'assistant',
      content: response.text,
    });

    // 7. 检查是否需要压缩历史
    if (this.shouldCompressHistory(session)) {
      await this.sessionManager.compressHistory(session.id);
    }
  }

  private shouldCompressHistory(session: Session): boolean {
    // 超过50条消息时压缩
    return session.context.conversationHistory.length > 50;
  }
}
```

### 2.4 Worker管理器实现

```typescript
// src/worker/manager.ts
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { TmuxClient } from '../utils/tmux';

export class WorkerManager {
  private tmuxClient: TmuxClient;
  private baseDir: string;
  private scriptsDir: string;

  constructor(config: WorkerManagerConfig) {
    this.tmuxClient = new TmuxClient();
    this.baseDir = config.baseDir;
    this.scriptsDir = config.scriptsDir;
  }

  async spawnWorker(config: WorkerSpawnConfig): Promise<ClaudeWorker> {
    const workerId = this.generateId();
    const workerDir = path.join(this.baseDir, 'workers', workerId);

    // 1. 创建Worker目录结构
    await this.createWorkerDirectory(workerDir);

    // 2. 生成并写入Hooks配置
    const hooksConfig = this.generateHooksConfig(workerId);
    await fs.writeFile(
      path.join(workerDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: hooksConfig }, null, 2)
    );

    // 3. 写入任务描述
    await fs.writeFile(
      path.join(workerDir, 'task.md'),
      `# 任务描述\n\n${config.task}`
    );

    // 4. 创建tmux会话
    const tmuxSession = `worker_${workerId.slice(0, 8)}`;
    await this.tmuxClient.createSession({
      name: tmuxSession,
      cwd: config.workDir || workerDir,
      detached: true,
    });

    // 5. 设置环境变量
    await this.tmuxClient.setEnvironment(tmuxSession, {
      XDEV_WORKER_ID: workerId,
      XDEV_SESSION_ID: config.sessionId,
    });

    // 6. 构建并执行Claude命令
    const claudeCmd = this.buildClaudeCommand(workerId, config);
    await this.tmuxClient.sendKeys(tmuxSession, claudeCmd);

    // 7. 创建Worker记录
    const worker: ClaudeWorker = {
      id: workerId,
      name: config.name || `Worker-${workerId.slice(0, 6)}`,
      sessionId: config.sessionId,
      status: 'running',
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
        notifyScript: path.join(this.scriptsDir, 'notify_xdev.sh'),
        completedScript: path.join(this.scriptsDir, 'worker_completed.sh'),
      },
      createdAt: new Date(),
      startedAt: new Date(),
    };

    await this.saveWorkerMeta(worker);
    return worker;
  }

  private buildClaudeCommand(workerId: string, config: WorkerSpawnConfig): string {
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

    // 输出到日志文件
    const logFile = path.join(this.baseDir, 'workers', workerId, 'output.log');
    parts.push(`"${config.task}" 2>&1 | tee "${logFile}"`);

    return parts.join(' ');
  }

  private generateHooksConfig(workerId: string): HooksConfig {
    return {
      Notification: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `${this.scriptsDir}/notify_xdev.sh ${workerId}`,
        }],
      }],
      Stop: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `${this.scriptsDir}/worker_completed.sh ${workerId}`,
        }],
      }],
      SubagentStop: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `${this.scriptsDir}/subagent_notify.sh ${workerId}`,
        }],
      }],
      PostToolUse: [{
        matcher: 'Edit|Write',
        hooks: [{
          type: 'command',
          command: `echo "file_modified" >> ${this.baseDir}/workers/${workerId}/actions.log`,
        }],
      }],
    };
  }

  async getStatus(workerId: string): Promise<WorkerStatusInfo> {
    const worker = await this.loadWorkerMeta(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    // 检查tmux会话状态
    const tmuxAlive = await this.tmuxClient.sessionExists(worker.tmuxSession);

    // 读取进度文件
    let progress = worker.progress;
    try {
      const progressData = await fs.readFile(worker.hooks.progressFile, 'utf-8');
      progress = JSON.parse(progressData);
    } catch {
      // 进度文件不存在，使用默认值
    }

    // 统计操作日志
    let toolCalls = 0;
    let filesModified = 0;
    try {
      const logContent = await fs.readFile(
        path.join(this.baseDir, 'workers', workerId, 'actions.log'),
        'utf-8'
      );
      const lines = logContent.trim().split('\n').filter(Boolean);
      toolCalls = lines.length;
      filesModified = lines.filter(l => l === 'file_modified').length;
    } catch {
      // 日志文件不存在
    }

    return {
      ...worker,
      status: tmuxAlive ? worker.status : 'stopped',
      progress: {
        ...progress,
        toolCalls,
        filesModified,
      },
    };
  }

  async terminate(workerId: string, force: boolean = false): Promise<void> {
    const worker = await this.loadWorkerMeta(workerId);
    if (!worker) return;

    if (force) {
      // 强制终止
      await this.tmuxClient.killSession(worker.tmuxSession);
    } else {
      // 发送Ctrl+C信号
      await this.tmuxClient.sendKeys(worker.tmuxSession, 'C-c');
      // 等待3秒后检查是否退出
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (await this.tmuxClient.sessionExists(worker.tmuxSession)) {
        await this.tmuxClient.killSession(worker.tmuxSession);
      }
    }

    // 更新状态
    worker.status = 'completed';
    worker.completedAt = new Date();
    await this.saveWorkerMeta(worker);
  }

  private async createWorkerDirectory(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  }

  private async saveWorkerMeta(worker: ClaudeWorker): Promise<void> {
    const metaPath = path.join(
      this.baseDir,
      'workers',
      worker.id,
      'meta.json'
    );
    await fs.writeFile(metaPath, JSON.stringify(worker, null, 2));
  }

  private async loadWorkerMeta(workerId: string): Promise<ClaudeWorker | null> {
    const metaPath = path.join(this.baseDir, 'workers', workerId, 'meta.json');
    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private generateId(): string {
    return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
}
```

### 2.5 Hooks接收器实现

```typescript
// src/worker/hooks-receiver.ts
import express, { Request, Response } from 'express';
import { WorkerManager } from './manager';
import { FeishuClient } from '../feishu/client';
import { SessionManager } from '../session/manager';

export class HooksReceiver {
  private app: express.Application;
  private workerManager: WorkerManager;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager;
  private notificationThrottle: Map<string, number> = new Map();

  constructor(
    workerManager: WorkerManager,
    feishuClient: FeishuClient,
    sessionManager: SessionManager
  ) {
    this.workerManager = workerManager;
    this.feishuClient = feishuClient;
    this.sessionManager = sessionManager;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    // 接收Notification Hook
    this.app.post('/internal/worker/notify', this.handleNotification.bind(this));

    // 接收Stop Hook
    this.app.post('/internal/worker/complete', this.handleComplete.bind(this));

    // 接收SubagentStop Hook
    this.app.post('/internal/worker/subagent', this.handleSubagent.bind(this));
  }

  private async handleNotification(req: Request, res: Response): Promise<void> {
    const { worker_id, type, message, timestamp } = req.body;

    try {
      const worker = await this.workerManager.getStatus(worker_id);
      if (!worker) {
        res.status(404).send('Worker not found');
        return;
      }

      // 更新进度
      worker.progress.currentStep = message;
      worker.progress.lastUpdate = new Date(timestamp);

      // 检查是否应该节流通知
      if (this.shouldThrottleNotification(worker_id)) {
        res.send('OK (throttled)');
        return;
      }

      // 获取会话设置
      const session = await this.sessionManager.get(worker.sessionId);
      if (!session?.settings.notifyOnProgress) {
        res.send('OK (notification disabled)');
        return;
      }

      // 发送飞书通知
      await this.feishuClient.sendCard(session.feishuChatId, {
        header: {
          title: { content: `📊 ${worker.name} 进度更新`, tag: 'plain_text' },
          template: 'blue',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**当前步骤**: ${message}\n**状态**: 运行中\n**已运行**: ${this.formatDuration(worker.startedAt!)}`,
          },
        ],
      });

      this.notificationThrottle.set(worker_id, Date.now());
      res.send('OK');
    } catch (error) {
      console.error('Handle notification error:', error);
      res.status(500).send('Internal error');
    }
  }

  private async handleComplete(req: Request, res: Response): Promise<void> {
    const { worker_id, status, result, cost, duration } = req.body;

    try {
      const worker = await this.workerManager.getStatus(worker_id);
      if (!worker) {
        res.status(404).send('Worker not found');
        return;
      }

      // 更新Worker状态
      await this.workerManager.updateStatus(worker_id, {
        status: status === 'success' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          success: status === 'success',
          summary: result,
          cost: cost || 0,
          duration: duration || 0,
        },
      });

      // 获取会话并发送完成通知
      const session = await this.sessionManager.get(worker.sessionId);

      const emoji = status === 'success' ? '✅' : '❌';
      await this.feishuClient.sendCard(session.feishuChatId, {
        header: {
          title: { content: `${emoji} ${worker.name} 任务完成`, tag: 'plain_text' },
          template: status === 'success' ? 'green' : 'red',
        },
        elements: [
          {
            tag: 'markdown',
            content: `**状态**: ${status === 'success' ? '成功' : '失败'}\n**耗时**: ${this.formatDuration(worker.startedAt!, new Date())}\n**结果**:\n${result}`,
          },
        ],
      });

      res.send('OK');
    } catch (error) {
      console.error('Handle complete error:', error);
      res.status(500).send('Internal error');
    }
  }

  private async handleSubagent(req: Request, res: Response): Promise<void> {
    const { worker_id, subagent_type, result } = req.body;

    // 子代理完成，可选通知
    console.log(`Subagent ${subagent_type} completed for worker ${worker_id}`);
    res.send('OK');
  }

  private shouldThrottleNotification(workerId: string): boolean {
    const lastTime = this.notificationThrottle.get(workerId) || 0;
    const throttleInterval = 30000; // 30秒
    return Date.now() - lastTime < throttleInterval;
  }

  private formatDuration(start: Date, end: Date = new Date()): string {
    const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分钟`;
  }

  listen(port: number): void {
    this.app.listen(port, () => {
      console.log(`Hooks receiver listening on port ${port}`);
    });
  }
}
```

### 2.6 飞书客户端实现

```typescript
// src/feishu/client.ts
import * as lark from '@larksuiteoapi/node-sdk';

export class FeishuClient {
  private client: lark.Client;
  private wsClient?: lark.WSClient;
  private messageHandler?: (msg: FeishuMessage) => Promise<void>;

  constructor(config: FeishuConfig) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    // 长连接模式（开发推荐）
    if (config.useWebSocket) {
      this.wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });
    }
  }

  setMessageHandler(handler: (msg: FeishuMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.wsClient) {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          if (this.messageHandler) {
            await this.messageHandler({
              messageId: data.message.message_id,
              chatId: data.message.chat_id,
              userId: data.sender.sender_id.user_id,
              content: this.parseContent(data.message.content),
              msgType: data.message.message_type,
              timestamp: new Date(parseInt(data.message.create_time) * 1000),
            });
          }
        },
      });

      await this.wsClient.start({ eventDispatcher });
    }
  }

  async sendMessage(chatId: string, reply: FeishuReply): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: this.formatContent(reply),
        msg_type: reply.type === 'interactive' ? 'interactive' : 'text',
      },
    });
  }

  async sendCard(chatId: string, card: lark.MessageCard): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  }

  private parseContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      if (parsed.text) return parsed.text;
      return content;
    } catch {
      return content;
    }
  }

  private formatContent(reply: FeishuReply): string {
    if (reply.type === 'interactive' && reply.card) {
      return JSON.stringify(reply.card);
    }
    return JSON.stringify({ text: reply.content });
  }
}
```

## 3. Hook脚本实现

### 3.1 notify_xdev.sh

```bash
#!/bin/bash
# /var/lib/xdev/scripts/notify_xdev.sh
# Worker向艾克斯发送进度通知

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8080}"

# 从stdin读取hook数据
INPUT=$(cat)

# 提取关键信息
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
NOTIFICATION=$(echo "$INPUT" | jq -r '.notification // empty')
REASON=$(echo "$INPUT" | jq -r '.reason // "progress"')

# 如果没有提供worker_id，从session_id提取
if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$SESSION_ID"
fi

# 发送到艾克斯
if [ -n "$WORKER_ID" ] && [ -n "$NOTIFICATION" ]; then
  curl -s -X POST "http://${XDEV_HOST}:${XDEV_PORT}/internal/worker/notify" \
    -H "Content-Type: application/json" \
    -d "{
      \"worker_id\": \"$WORKER_ID\",
      \"type\": \"$REASON\",
      \"message\": $(echo "$NOTIFICATION" | jq -R .),
      \"timestamp\": \"$(date -Iseconds)\"
    }" > /dev/null 2>&1
fi

# 同时写入进度文件（备用）
PROGRESS_FILE="/var/lib/xdev/workers/${WORKER_ID}/progress.json"
if [ -d "$(dirname "$PROGRESS_FILE")" ]; then
  echo "$INPUT" > "$PROGRESS_FILE"
fi
```

### 3.2 worker_completed.sh

```bash
#!/bin/bash
# /var/lib/xdev/scripts/worker_completed.sh
# Worker完成时通知艾克斯

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8080}"

# 从stdin读取hook数据
INPUT=$(cat)

# 提取关键信息
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
RESULT=$(echo "$INPUT" | jq -r '.result // empty')
COST=$(echo "$INPUT" | jq -r '.cost_usd // 0')
DURATION=$(echo "$INPUT" | jq -r '.duration_ms // 0')

if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$SESSION_ID"
fi

# 确定状态
if echo "$RESULT" | grep -qi "error\|failed"; then
  STATUS="failed"
else
  STATUS="success"
fi

# 发送完成通知
curl -s -X POST "http://${XDEV_HOST}:${XDEV_PORT}/internal/worker/complete" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"status\": \"$STATUS\",
    \"result\": $(echo "$RESULT" | jq -R .),
    \"cost\": $COST,
    \"duration\": $DURATION,
    \"timestamp\": \"$(date -Iseconds)\"
  }" > /dev/null 2>&1

# 保存完整结果
RESULT_FILE="/var/lib/xdev/workers/${WORKER_ID}/result.json"
if [ -d "$(dirname "$RESULT_FILE")" ]; then
  echo "$INPUT" > "$RESULT_FILE"
fi
```

### 3.3 subagent_notify.sh

```bash
#!/bin/bash
# /var/lib/xdev/scripts/subagent_notify.sh
# 子代理完成时通知

WORKER_ID="$1"
XDEV_HOST="${XDEV_HOST:-localhost}"
XDEV_PORT="${XDEV_PORT:-8080}"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
PARENT_ID=$(echo "$INPUT" | jq -r '.parent_session_id // empty')
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.subagent_type // "unknown"')
RESULT=$(echo "$INPUT" | jq -r '.result // empty')

if [ -z "$WORKER_ID" ]; then
  WORKER_ID="$PARENT_ID"
fi

# 记录子代理活动
curl -s -X POST "http://${XDEV_HOST}:${XDEV_PORT}/internal/worker/subagent" \
  -H "Content-Type: application/json" \
  -d "{
    \"worker_id\": \"$WORKER_ID\",
    \"subagent_id\": \"$SESSION_ID\",
    \"subagent_type\": \"$SUBAGENT_TYPE\",
    \"result\": $(echo "$RESULT" | head -c 500 | jq -R .),
    \"timestamp\": \"$(date -Iseconds)\"
  }" > /dev/null 2>&1
```

## 4. 配置文件

### 4.1 主配置文件 (config.yaml)

```yaml
# /var/lib/xdev/config/config.yaml
server:
  host: "0.0.0.0"
  port: 8080
  hooks_port: 8081

xdev:
  model: "claude-sonnet-4-5-20250929"
  max_context_messages: 50
  compress_threshold: 40

feishu:
  app_id: "${FEISHU_APP_ID}"
  app_secret: "${FEISHU_APP_SECRET}"
  use_websocket: true  # 开发时使用WebSocket，生产环境使用Webhook
  # webhook_path: "/webhook/feishu"

worker:
  base_dir: "/var/lib/xdev"
  scripts_dir: "/var/lib/xdev/scripts"
  max_workers_per_session: 5
  default_timeout: 3600
  default_model: "sonnet"

storage:
  type: "sqlite"
  sqlite:
    path: "/var/lib/xdev/data/xdev.db"
  # redis:
  #   host: "localhost"
  #   port: 6379
  #   db: 0

logging:
  level: "info"
  format: "json"
  output: "/var/log/xdev/xdev.log"
```

### 4.2 AI艾克斯的任务处理能力

AI艾克斯本质上是一个**Claude Agent实例**，具备Claude的全部能力。它会根据任务复杂度自动选择处理方式：

```
用户消息 → AI艾克斯 (Claude Agent)
              │
              ├── 🟢 简单任务 → 直接处理
              │   ├── 问答/咨询（解释概念、提供建议）
              │   ├── 代码分析（阅读、理解、解释）
              │   ├── 文件读取（查看配置、日志等）
              │   ├── 简单编辑（修改配置、小bug修复）
              │   ├── 信息查询（搜索、总结）
              │   └── 任务规划（分析需求、制定方案）
              │
              ├── 🟡 中等任务 → 询问后决定
              │   ├── 多文件修改
              │   ├── 需要运行测试
              │   └── 预计5-30分钟
              │
              └── 🔴 复杂任务 → 创建Worker
                  ├── 大规模重构
                  ├── 多子系统操作
                  ├── 长时间运行（>30分钟）
                  └── 需要独立进度追踪
```

**艾克斯作为Claude的能力示例**：

```
用户: 帮我看看 config.yaml 里数据库配置对不对
艾克斯: 让我看看... [读取文件]

数据库配置看起来没问题：
- host: localhost ✓
- port: 5432 ✓
- database: myapp ✓

建议：生产环境建议把密码改用环境变量 ${DB_PASSWORD}

用户: 帮我把这个密码改成环境变量
艾克斯: 好的，已修改：[编辑文件]

原来: password: "mysecretpass"
现在: password: "${DB_PASSWORD}"

记得在 .env 文件中添加 DB_PASSWORD=mysecretpass
```

**艾克斯可用的工具（作为Claude Agent）**：
```typescript
const xdevTools = [
  // 文件操作
  'Read',      // 读取文件
  'Edit',      // 编辑文件
  'Write',     // 写入文件
  'Glob',      // 搜索文件
  'Grep',      // 搜索内容

  // 系统操作
  'Bash',      // 执行命令

  // Worker管理（自定义工具）
  'spawn_worker',      // 创建Worker
  'check_worker',      // 检查Worker状态
  'list_workers',      // 列出Workers
  'terminate_worker',  // 终止Worker

  // 通信
  'send_feishu_card',  // 发送飞书卡片
];
```

### 4.3 启动机制（Systemd）

AI艾克斯是一个**持续运行的后台服务**，通过Systemd管理：

#### 服务配置文件

```ini
# /etc/systemd/system/xdev.service
[Unit]
Description=AI管家艾克斯服务
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=xdev
Group=xdev
WorkingDirectory=/opt/xdev
ExecStart=/usr/bin/node /opt/xdev/dist/index.js
Restart=on-failure
RestartSec=5

# 环境变量
EnvironmentFile=/etc/xdev/environment

# 资源限制
LimitNOFILE=65535
MemoryMax=2G

# 确保tmux socket可访问
ExecStartPre=/usr/bin/tmux start-server

[Install]
WantedBy=multi-user.target
```

#### 部署脚本

```bash
#!/bin/bash
# install-xdev.sh - 一键安装脚本

set -e

XDEV_HOME="/var/lib/xdev"
XDEV_LOG="/var/log/xdev"
XDEV_USER="xdev"

echo "=== 安装AI管家艾克斯 ==="

# 1. 创建用户
if ! id "$XDEV_USER" &>/dev/null; then
    useradd -r -s /bin/bash "$XDEV_USER"
    echo "✓ 创建用户 $XDEV_USER"
fi

# 2. 创建目录
mkdir -p "$XDEV_HOME"/{data,workers,sessions,scripts,config}
mkdir -p "$XDEV_LOG"
chown -R "$XDEV_USER:$XDEV_USER" "$XDEV_HOME" "$XDEV_LOG"
echo "✓ 创建目录结构"

# 3. 复制脚本
cp scripts/*.sh "$XDEV_HOME/scripts/"
chmod +x "$XDEV_HOME/scripts/"*.sh
echo "✓ 复制Hook脚本"

# 4. 创建环境变量文件
if [ ! -f /etc/xdev/environment ]; then
    cat > /etc/xdev/environment << 'EOF'
# Claude API
ANTHROPIC_API_KEY=your-key-here

# 飞书配置
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-secret
FEISHU_USE_WEBSOCKET=true

# 艾克斯配置
XDEV_HOME=/var/lib/xdev
XDEV_MODEL=claude-sonnet-4-5-20250929
XDEV_DB=/var/lib/xdev/data/xdev.db
XDEV_HOOKS_PORT=8081
EOF
    echo "✓ 创建环境变量文件（请编辑 /etc/xdev/environment）"
fi

# 5. 安装Systemd服务
cp xdev.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable xdev
echo "✓ 安装Systemd服务"

echo ""
echo "=== 安装完成 ==="
echo "1. 编辑 /etc/xdev/environment 填写配置"
echo "2. 运行 sudo systemctl start xdev 启动服务"
echo "3. 运行 sudo journalctl -u xdev -f 查看日志"
```

#### 管理命令

```bash
# 启动服务
sudo systemctl start xdev

# 停止服务
sudo systemctl stop xdev

# 重启服务
sudo systemctl restart xdev

# 查看状态
sudo systemctl status xdev

# 查看日志
sudo journalctl -u xdev -f

# 开机自启
sudo systemctl enable xdev

# 禁用开机自启
sudo systemctl disable xdev
```

### 4.4 艾克斯入口文件

```typescript
// src/index.ts - 艾克斯启动入口
import 'dotenv/config';
import { XdevService } from './core/xdev';
import { HooksReceiver } from './worker/hooks-receiver';
import { createLogger } from './utils/logger';

const logger = createLogger('main');

async function main() {
  logger.info('AI管家艾克斯启动中...');

  // 1. 初始化艾克斯服务
  const xdev = new XdevService({
    model: process.env.XDEV_MODEL || 'claude-sonnet-4-5-20250929',
    storage: {
      type: 'sqlite',
      path: process.env.XDEV_DB || '/var/lib/xdev/data/xdev.db',
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID!,
      appSecret: process.env.FEISHU_APP_SECRET!,
      useWebSocket: process.env.FEISHU_USE_WEBSOCKET !== 'false',
    },
    worker: {
      baseDir: process.env.XDEV_HOME || '/var/lib/xdev',
      scriptsDir: '/var/lib/xdev/scripts',
    },
  });

  // 2. 启动Hooks接收器（接收Worker通知）
  const hooksReceiver = new HooksReceiver(
    xdev.workerManager,
    xdev.feishuClient,
    xdev.sessionManager
  );
  const hooksPort = parseInt(process.env.XDEV_HOOKS_PORT || '8081');
  hooksReceiver.listen(hooksPort);
  logger.info(`Hooks接收器已启动，监听端口 ${hooksPort}`);

  // 3. 启动飞书连接（开始接收用户消息）
  await xdev.start();
  logger.info('飞书连接已建立，艾克斯开始工作');

  // 4. 优雅关闭
  process.on('SIGTERM', async () => {
    logger.info('收到SIGTERM信号，正在关闭...');
    await xdev.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('收到SIGINT信号，正在关闭...');
    await xdev.stop();
    process.exit(0);
  });

  logger.info('AI管家艾克斯已就绪 ✅');
}

main().catch((error) => {
  logger.error('启动失败:', error);
  process.exit(1);
});
```

### 4.5 环境变量配置

```bash
# /etc/xdev/environment 或 .env

# Claude API
ANTHROPIC_API_KEY=sk-ant-xxx

# 飞书配置
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ENCRYPT_KEY=xxx
FEISHU_USE_WEBSOCKET=true

# 艾克斯配置
XDEV_HOME=/var/lib/xdev
XDEV_MODEL=claude-sonnet-4-5-20250929
XDEV_DB=/var/lib/xdev/data/xdev.db
XDEV_HOOKS_PORT=8081

# 日志
LOG_LEVEL=info
LOG_FORMAT=json
```

## 5. 交互示例

### 5.1 基本对话
```
用户: 你好
艾克斯: 你好！我是AI管家艾克斯 👋

有什么我可以帮你的吗？
- 简单问题我可以直接回答
- 复杂任务我会创建专门的Worker来处理

用户: 帮我看看 src/auth 目录下的代码
艾克斯: 这是一个中等复杂度的任务。我可以：
1. 直接帮你分析代码结构
2. 创建一个Worker来深入分析

你希望我怎么处理？

用户: 直接分析吧
艾克斯: 好的，让我来看看...

[src/auth目录分析]
- `auth.ts`: 主要认证逻辑，使用JWT
- `middleware.ts`: 认证中间件
- `utils.ts`: 工具函数

建议优化点：
1. **token验证**可以添加缓存
2. **错误处理**可以更统一
```

### 5.2 创建Worker
```
用户: 帮我重构整个认证模块，增加OAuth2.0支持

艾克斯: 这是一个复杂任务，需要较长时间执行。
我建议创建一个专门的Worker来处理。

📋 **任务概要**:
- 重构认证模块
- 增加OAuth2.0支持
- 预计执行时间: 30-60分钟

是否创建Worker？(回复 y 确认)

用户: y

艾克斯: ✅ 已创建Worker [认证模块重构专家]

**ID**: w_abc123
**状态**: 运行中
**工作目录**: /home/user/projects/app

你可以随时：
- 发送 `/worker progress w_abc123` 查看进度
- 发送 `/worker list` 查看所有Worker

---

[5分钟后]
艾克斯: 📊 **Worker进度更新**: 认证模块重构专家

**当前步骤**: 分析现有认证流程
**已修改文件**: 2个
**进度**: 15%

---

[25分钟后]
艾克斯: ✅ **Worker任务完成**: 认证模块重构专家

**结果**:
- 重构了auth模块，提高可维护性
- 新增OAuth2.0支持（Google、GitHub）
- 添加了相关单元测试
- 更新了文档

**耗时**: 28分钟
**修改文件**: 8个
```

---

**文档版本**: v2.0
**更新日期**: 2026-02-18
**相关文档**: AI管家艾克斯-技术设计文档.md
