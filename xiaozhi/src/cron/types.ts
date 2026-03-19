// src/cron/types.ts
// Cron 定时任务类型定义

/**
 * Cron 任务状态
 */
export type CronTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'disabled';

/**
 * Cron 任务配置
 */
export interface CronTask {
  id: string;
  description: string;     // 自然语言描述
  cronExpr: string;        // cron 表达式 "0 6 * * *"
  taskContent: string;     // 要执行的任务内容
  chatId: string;          // 关联的飞书聊天 ID
  enabled: boolean;
  silent: boolean;         // 静默模式 - 不发送开始通知
  lastRun?: Date;          // 上次执行时间
  lastError?: string;      // 上次错误信息
  lastResult?: string;     // 上次执行结果
  createdAt: Date;
  runCount: number;        // 执行次数
}

/**
 * 创建 Cron 任务参数
 */
export interface CreateCronTaskParams {
  description: string;     // 自然语言描述（必需）
  cronExpr: string;        // cron 表达式（必需）
  taskContent: string;     // 任务内容（必需）
  chatId: string;          // 飞书聊天 ID（必需）
  silent?: boolean;        // 静默模式
}

/**
 * Cron 任务记录（数据库存储格式）
 */
export interface CronTaskRecord {
  id: string;
  description: string;
  cron_expr: string;
  task_content: string;
  chat_id: string;
  enabled: number;
  silent: number;
  last_run: string | null;
  last_error: string | null;
  last_result: string | null;
  run_count: number;
  created_at: string;
}

/**
 * Cron 触发回调数据
 */
export interface CronTriggerCallback {
  type: 'cron_trigger';
  taskId: string;
  taskDescription: string;
  taskContent: string;
  chatId: string;
  timestamp: string;
}

/**
 * Cron 管理器配置
 */
export interface CronManagerConfig {
  callbackUrl: string;     // 回调 URL
  maxTasks: number;        // 最大任务数
  enablePersistence: boolean;
}

/**
 * Cron 表达式解析结果
 */
export interface CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
  description: string;     // 人类可读描述
}
