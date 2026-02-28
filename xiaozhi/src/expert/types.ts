// src/expert/types.ts
// 统一专家系统类型定义
// 合并了原 Worker 和专家的概念

// ==================== 错误类型 ====================

/**
 * 专家错误代码
 */
export enum ExpertErrorCode {
  // 进程相关错误
  PROCESS_SPAWN_FAILED = 'PROCESS_SPAWN_FAILED',
  PROCESS_ERROR = 'PROCESS_ERROR',
  PROCESS_EXIT_UNEXPECTED = 'PROCESS_EXIT_UNEXPECTED',
  PROCESS_DIED = 'PROCESS_DIED',

  // 配置和参数错误
  INVALID_WORKDIR = 'INVALID_WORKDIR',
  RECURSION_DENIED = 'RECURSION_DENIED',
  EXPERT_NOT_FOUND = 'EXPERT_NOT_FOUND',
  EXPERT_BUSY = 'EXPERT_BUSY',

  // 执行错误
  TIMEOUT = 'TIMEOUT',
  TASK_FAILED = 'TASK_FAILED',
  CALLBACK_FAILED = 'CALLBACK_FAILED',

  // 系统错误
  DATABASE_ERROR = 'DATABASE_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/**
 * 专家错误
 */
export interface ExpertError extends Error {
  code: ExpertErrorCode;
  details?: Record<string, unknown>;
}

// ==================== 专家配置 ====================

/**
 * 专家类型
 */
export type ExpertType = 'predefined' | 'dynamic';

/**
 * 专家状态
 */
export type ExpertStatus = 'idle' | 'busy' | 'queued';

/**
 * 专家配置
 */
export interface ExpertConfig {
  id: string;                    // 专家唯一 ID
  name: string;                  // 专家名称（coder、analyst 等）
  description: string;           // 专家描述
  specialties: string[];         // 专长领域
  type: ExpertType;              // 预定义/动态创建
  workDir: string;               // 专家工作目录
  promptPath: string;            // CLAUDE.md 路径
  customPrompt?: string;         // 自定义 prompt（动态专家）
  stats: ExpertStats;            // 统计信息
}

/**
 * 专家统计信息
 */
export interface ExpertStats {
  totalCalls: number;
  successCount: number;
  lastUsedAt?: Date;
  createdAt: Date;
}

/**
 * 专家运行时状态
 */
export interface ExpertRuntimeStatus {
  name: string;
  status: ExpertStatus;
  currentTask?: string;
  lastActive?: Date;
  completedTasks: number;
  startTime?: Date;              // 任务开始时间（用于超时检测）
  processId?: number;            // 进程 ID
  sessionId?: string;            // 当前会话 ID
}

// ==================== 会话管理 ====================

/**
 * 会话状态
 *
 * 状态流转：
 * - running -> completed: 正常完成
 * - running -> failed: 执行失败
 * - running -> terminated: 被系统强制终止（超时等）
 *
 * 终态保护：completed/failed/terminated 状态不应被覆盖
 */
export type SessionStatus = 'running' | 'completed' | 'failed' | 'terminated';

/**
 * 终态集合（不可再变更的状态）
 */
export const TERMINAL_STATES: SessionStatus[] = ['completed', 'failed', 'terminated'];

/**
 * 会话任务信息
 */
export interface SessionTask {
  description: string;           // 任务描述
  category?: string;             // 任务分类
  tags: string[];                // 标签
}

/**
 * 会话执行信息
 */
export interface SessionExecution {
  model: string;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;             // 毫秒
}

/**
 * 会话结果
 */
export interface SessionResult {
  success: boolean;
  summary: string;
  details?: string;
  artifacts?: string[];          // 生成的文件路径
}

/**
 * 专家会话记录
 */
export interface ExpertSession {
  id: string;                    // 会话 ID
  expertId: string;              // 所属专家 ID
  expertName: string;            // 专家名称
  task: SessionTask;             // 任务信息
  status: SessionStatus;
  execution: SessionExecution;   // 执行信息
  result?: SessionResult;        // 结果
  workDir?: string;              // 工作目录
  claudeSessionId?: string;      // Claude CLI 会话 ID（用于 --resume）
}

// ==================== 调用参数 ====================

/**
 * 专家调用参数
 */
export interface ExpertCallParams {
  expertName: string;            // 专家名称
  task: string;                  // 任务描述
  workDir?: string;              // 工作目录
  model?: string;                // 模型名称
  category?: string;             // 任务分类
  tags?: string[];               // 标签
  shouldContinue?: boolean;      // true: 使用 --continue 继续该目录最近会话; false: 新会话
}

/**
 * 创建专家参数
 */
export interface CreateExpertParams {
  name: string;
  description: string;
  specialties: string[];
  customPrompt?: string;
  type?: ExpertType;
}

// ==================== 消息和回调 ====================

/**
 * 专家间消息
 */
export interface ExpertMessage {
  id: string;
  from: string;                  // 发送者（专家名或 'xiaozhi'）
  to: string;                    // 接收者（专家名）
  content: string;
  timestamp: Date;
}

/**
 * 专家完成回调数据
 */
export interface ExpertCompleteCallback {
  expert: string;                // 专家名称
  sessionId?: string;            // 会话 ID
  success: boolean;
  result: string;
  task?: string;                 // 任务描述
  duration?: number;             // 耗时（毫秒）
  cost?: number;                 // 成本
}

/**
 * 会话继续参数
 */
export interface SessionContinueParams {
  message: string;               // 继续消息
}

// ==================== 管理器配置 ====================

/**
 * 专家管理器配置
 */
export interface ExpertManagerConfig {
  maxConcurrent?: number;        // 最大并发数，默认 5
  defaultTimeout?: number;       // 默认超时时间（毫秒），默认 30 分钟
  preventRecursion?: boolean;    // 防止专家直接调用专家
  maxTaskLength?: number;        // 任务描述最大长度，默认 10000
  maxMessagesCount?: number;     // 消息存储最大数量，默认 1000
  sessionRetentionDays?: number; // 会话保留天数，默认 30
}

// ==================== 任务队列 ====================

/**
 * 排队中的任务
 */
export interface QueuedTask {
  id: string;
  expertName: string;
  task: string;
  workDir?: string;
  model?: string;
  category?: string;
  tags?: string[];
  queuedAt: Date;
}

/**
 * 任务队列状态
 */
export interface QueueStatus {
  queueLength: number;
  runningCount: number;
  maxConcurrent: number;
  tasks: QueuedTask[];
}

// ==================== API 响应 ====================

/**
 * 专家调用响应
 */
export interface ExpertCallResponse {
  status: 'ok' | 'error';
  expert?: string;
  sessionId?: string;
  message?: string;
  error?: string;
}

/**
 * 会话状态响应
 */
export interface SessionStatusResponse {
  id: string;
  expertName: string;
  status: SessionStatus;
  task: SessionTask;
  execution: SessionExecution;
  result?: SessionResult;
}

// ==================== 数据库记录类型 ====================

/**
 * 专家数据库记录
 */
export interface ExpertRecord {
  id: string;
  name: string;
  description: string;
  specialties: string;           // JSON 字符串
  type: string;
  work_dir: string;
  prompt_path: string;
  custom_prompt?: string;
  stats: string;                 // JSON 字符串
  created_at: string;
}

/**
 * 会话数据库记录
 */
export interface SessionRecord {
  id: string;
  expert_id: string;
  expert_name: string;
  task_description: string;
  task_category?: string;
  task_tags: string;             // JSON 字符串
  status: string;
  model: string;
  started_at: string;
  completed_at?: string;
  duration?: number;
  result_success?: number;       // SQLite 使用 0/1 表示布尔值
  result_summary?: string;
  result_details?: string;
  result_artifacts?: string;     // JSON 字符串
  work_dir?: string;
  claude_session_id?: string;
}
