// src/worker/types.ts
// Worker相关类型定义

export type WorkerStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'timeout';

/**
 * .worker.json 文件结构 - Worker 标识信息
 */
export interface WorkerIdentifier {
  id: string;
  name: string;
  type: 'claude-worker';
  createdAt: string;
  sessionId: string;
  status: WorkerStatus;
}

export interface WorkerTask {
  description: string;
  workDir: string;
  model: string;  // 模型名称，如 'glm-5', 'sonnet', 'opus', 'haiku' 等
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
  artifacts?: string[]; // 生成的文件路径
  cost: number;
  duration: number;
}

export interface WorkerHooks {
  progressFile: string;
  notifyScript: string;
  completedScript: string;
}

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

export interface WorkerSpawnConfig {
  sessionId: string;
  name?: string;
  task: string;
  workDir?: string;
  model?: string;  // 模型名称，如 'glm-5', 'sonnet', 'opus', 'haiku' 等
  timeout?: number;
  maxTurns?: number;
  maxBudget?: number;
  customPrompt?: string;  // 小智生成的自定义 prompt
}

export interface WorkerManagerConfig {
  baseDir: string;
  scriptsDir: string;
  xiaozhiHost: string;
  xiaozhiPort: number;
}

export interface HooksConfig {
  Notification: Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
  }>;
  Stop: Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
  }>;
  SubagentStop: Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
  }>;
  PostToolUse?: Array<{
    matcher: string;
    hooks: Array<{ type: string; command: string }>;
  }>;
}

// Hook事件数据类型
export interface NotificationHookData {
  session_id: string;
  notification: string;
  reason: string;
  timestamp: string;
}

export interface StopHookData {
  session_id: string;
  result: string;
  cost_usd: number;
  duration_ms: number;
  timestamp: string;
}

export interface SubagentStopHookData {
  session_id: string;
  parent_session_id: string;
  subagent_type: string;
  result: string;
  timestamp: string;
}

export interface PostToolUseHookData {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result: string;
  timestamp: string;
}
