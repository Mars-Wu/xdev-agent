// src/storage/types.ts
// 存储层类型定义 - 独立定义，不依赖已删除的模块

// ==================== 飞书会话记录（兼容旧版）====================

export interface SessionRecord {
  id: string
  name: string
  userId: string
  feishuChatId: string
  status: string
  context: string // JSON
  settings: string // JSON
  createdAt: string
  updatedAt: string
}

// ==================== Worker 记录（兼容旧版）====================

export interface WorkerRecord {
  id: string
  name: string
  sessionId: string
  status: string
  tmuxSession: string
  claudeSessionId: string
  task: string // JSON
  progress: string // JSON
  result: string // JSON
  hooks: string // JSON
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

// ==================== 文件记录（新增）====================

export interface FileRecord {
  id: string
  original_name: string
  local_path: string
  mime_type: string
  size: number
  chat_id: string
  message_id: string
  created_at: string
}

// ==================== 专家系统类型（兼容旧数据）====================

/**
 * 专家统计
 */
export interface ExpertStats {
  totalSessions: number
  successRate: number
  avgDuration: number
  lastUsed?: string
}

/**
 * 专家配置
 */
export interface ExpertConfig {
  id: string
  name: string
  description?: string
  specialties: string[]
  type: 'predefined' | 'custom'
  workDir: string
  promptPath?: string
  customPrompt?: string
  stats: ExpertStats
}

/**
 * 会话任务
 */
export interface SessionTask {
  description: string
  category?: string
  tags?: string[]
}

/**
 * 会话执行信息
 */
export interface SessionExecution {
  model: string
  startedAt: Date
  completedAt?: Date
  duration?: number
}

/**
 * 会话结果
 */
export interface SessionResult {
  success: boolean
  summary: string
  details?: string
  artifacts?: Record<string, unknown>
}

/**
 * 会话状态
 */
export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'terminated'

/**
 * 专家会话
 */
export interface ExpertSession {
  id: string
  expertId: string
  expertName: string
  task: SessionTask
  status: SessionStatus
  execution: SessionExecution
  result?: SessionResult
  workDir?: string
  claudeSessionId?: string
}

/**
 * 专家记录（数据库格式）
 */
export interface ExpertRecord {
  id: string
  name: string
  description?: string
  specialties?: string
  type: string
  work_dir: string
  prompt_path?: string
  custom_prompt?: string
  stats: string
  created_at: string
}

/**
 * 专家会话记录（数据库格式）
 */
export interface SessionRecord {
  id: string
  expert_id: string
  expert_name: string
  task_description?: string
  task_category?: string
  task_tags?: string
  status: string
  model?: string
  started_at: string
  completed_at?: string
  duration?: number
  result_success?: number
  result_summary?: string
  result_details?: string
  result_artifacts?: string
  work_dir?: string
  claude_session_id?: string
}

// ==================== Cron 定时任务类型（兼容旧数据）====================

/**
 * Cron 任务记录
 */
export interface CronTaskRecord {
  id: string
  description: string
  cron_expr: string
  task_content: string
  chat_id: string
  enabled: number
  silent: number
  last_run?: string
  last_error?: string
  last_result?: string
  run_count: number
  created_at: string
}
