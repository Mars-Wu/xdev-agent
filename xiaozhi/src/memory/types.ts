// src/memory/types.ts
// 记忆系统类型定义

/**
 * 记忆类型（参考 LangMem 三分法）
 */
export enum MemoryType {
  /** 语义记忆 - 事实、偏好、知识 */
  SEMANTIC = 'semantic',
  /** 情景记忆 - 事件、对话片段 */
  EPISODIC = 'episodic',
  /** 程序记忆 - 技能、流程、最佳实践 */
  PROCEDURAL = 'procedural',
}

/**
 * 记忆作用域
 */
export enum MemoryScope {
  /** 私有 - 仅当前用户 */
  PRIVATE = 'private',
  /** 团队 - 共享给团队成员 */
  TEAM = 'team',
  /** 项目 - 特定项目上下文 */
  PROJECT = 'project',
}

/**
 * 记忆分类（细粒度标签）
 */
export type MemoryCategory =
  | 'preference'    // 用户偏好
  | 'decision'      // 决策记录
  | 'fact'          // 事实信息
  | 'convention'    // 项目约定
  | 'procedure'     // 操作流程
  | 'feedback'      // 用户反馈
  | 'context'       // 上下文信息
  | 'topic'         // 主题分类
  | 'insight'       // 洞察总结
  | 'error'         // 错误及解决方案
  | 'resource';     // 资源链接

/**
 * 记忆条目（增强版）
 */
export interface MemoryEntry {
  /** 唯一标识 */
  id: string;
  /** 记忆内容 */
  content: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 作用域 */
  scope: MemoryScope;
  /** 分类标签 */
  category: MemoryCategory;
  /** 重要性 1-10 */
  importance: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问次数 */
  accessCount: number;
  /** 关联的主题标签 */
  tags: string[];
  /** 来源会话 ID */
  sessionId?: string;
  /** 关联的项目路径 */
  projectPath?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 会话记忆
 */
export interface SessionMemory {
  /** 会话 ID */
  sessionId: string;
  /** 会话名称 */
  sessionName: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 消息数量 */
  messageCount: number;
  /** 主题摘要 */
  topicSummary: string;
  /** 关键决策列表 */
  decisions: string[];
  /** 执行的操作 */
  actions: SessionAction[];
  /** 提取的记忆 ID 列表 */
  extractedMemoryIds: string[];
  /** 会话上下文 */
  context: {
    cwd?: string;
    project?: string;
    branch?: string;
    files?: string[];
    commands?: string[];
  };
  /** Token 统计 */
  tokenStats: {
    input: number;
    output: number;
    total: number;
  };
}

/**
 * 会话操作记录
 */
export interface SessionAction {
  /** 时间戳 */
  timestamp: number;
  /** 操作类型 */
  type: 'bash' | 'read' | 'write' | 'edit' | 'search' | 'other';
  /** 操作描述 */
  description: string;
  /** 是否成功 */
  success: boolean;
  /** 关联文件（如有） */
  file?: string;
}

/**
 * 记忆提取结果
 */
export interface ExtractionResult {
  /** 提取的记忆列表 */
  memories: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>[];
  /** 提取的主题 */
  topics: string[];
  /** 会话摘要 */
  summary: string;
}

/**
 * 记忆检索请求
 */
export interface MemoryRetrievalRequest {
  /** 查询文本 */
  query: string;
  /** 限制返回数量 */
  limit?: number;
  /** 过滤类型 */
  types?: MemoryType[];
  /** 过滤分类 */
  categories?: MemoryCategory[];
  /** 过滤作用域 */
  scopes?: MemoryScope[];
  /** 过滤标签 */
  tags?: string[];
  /** 最小重要性 */
  minImportance?: number;
  /** 是否包含会话记忆 */
  includeSessionMemory?: boolean;
}

/**
 * 记忆检索结果
 */
export interface MemoryRetrievalResult {
  /** 记忆条目 */
  entry: MemoryEntry;
  /** 相关性分数 0-1 */
  relevanceScore: number;
  /** 匹配原因 */
  matchReason: string;
}

/**
 * 记忆提取触发条件
 */
export interface ExtractionTrigger {
  /** Token 阈值 */
  tokenThreshold: number;
  /** 工具调用次数阈值 */
  toolCallThreshold: number;
  /** 时间间隔（毫秒） */
  timeInterval: number;
  /** 是否在会话结束时提取 */
  onSessionEnd: boolean;
  /** 是否在主题切换时提取 */
  onTopicChange: boolean;
}

/**
 * 记忆系统配置
 */
export interface MemorySystemConfig {
  /** 最大记忆条目数 */
  maxEntries: number;
  /** 单个文件最大大小（字节） */
  maxFileSize: number;
  /** 会话记忆保留天数 */
  sessionRetentionDays: number;
  /** 提取触发条件 */
  extractionTrigger: ExtractionTrigger;
  /** 是否启用后台提取 */
  enableBackgroundExtraction: boolean;
  /** 是否启用 LLM 检索 */
  enableLlmRetrieval: boolean;
  /** 团队记忆目录（可选） */
  teamMemoryDir?: string;
}

/**
 * 默认配置
 */
export const DEFAULT_MEMORY_CONFIG: MemorySystemConfig = {
  maxEntries: 500,
  maxFileSize: 50 * 1024, // 50KB
  sessionRetentionDays: 30,
  extractionTrigger: {
    tokenThreshold: 8000,
    toolCallThreshold: 10,
    timeInterval: 5 * 60 * 1000, // 5 分钟
    onSessionEnd: true,
    onTopicChange: true,
  },
  enableBackgroundExtraction: true,
  enableLlmRetrieval: true,
};

/**
 * 记忆文件元数据（frontmatter）
 */
export interface MemoryFileMetadata {
  /** 记忆 ID */
  id: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 作用域 */
  scope: MemoryScope;
  /** 分类 */
  category: MemoryCategory;
  /** 重要性 */
  importance: number;
  /** 创建时间 */
  createdAt: string;
  /** 标签 */
  tags: string[];
  /** 关联会话 */
  sessionId?: string;
  /** 关联项目 */
  projectPath?: string;
}
