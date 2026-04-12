// src/tools/index.ts
// 工具系统导出

// 接口定义
export {
  ToolParameterSchema,
  ToolDefinition,
  ToolResult,
  ToolContext,
  Tool,
  ToolCategory,
  ToolMetadata,
  FullTool,
  createTool,
  successResult,
  errorResult,
} from './tool-interface'

// 工具注册表
export {
  ToolRegistry,
  getToolRegistry,
  resetToolRegistry,
} from './tool-registry'

// 基础工具
export { bashTool, createBashTool } from './bash-tool'
export { readTool, writeTool, editTool, listTool, createFileTools } from './file-tools'

// Phase 2 工具
export { globTool, createGlobTool } from './glob-tool'
export { grepTool, createGrepTool } from './grep-tool'
export { webSearchTool, createWebSearchTool } from './web-search-tool'
export { webFetchTool, createWebFetchTool } from './web-fetch-tool'
export { browserAdapterTool, createBrowserAdapterTool } from './browser-adapter'

// Phase 3 工具
export { agentTool, createAgentTool } from './agent-tool'
export { scheduleTool, createScheduleTool, stopAllScheduledJobs } from './schedule-tool'

// Skill 工具
export { createSkillTool, createListSkillsTool, createGetSkillInfoTool } from '../skills/skill-tool'

// Todo 工具 (s03)
export { createTodoTool, createStartTodoTool, createCompleteTodoTool } from './todo-tool'
export { TodoManager, getTodoManager, resetTodoManager } from './todo-manager'
export type { TodoItem, TodoStatus, TodoManagerConfig } from './todo-manager'

// Task 工具 (s07)
export { createTaskTool, createReadyTasksTool } from './task-tool'
export { TaskSystem, getTaskSystem, resetTaskSystem } from './task-system'
export type { Task, TaskStatus, TaskPriority, TaskSystemConfig } from './task-system'

// Background 工具 (s08)
export { createBackgroundTool, createNotificationTool } from './background-tool'
export {
  BackgroundTaskManager,
  getBackgroundTaskManager,
  resetBackgroundTaskManager,
} from './background-tasks'
export type {
  BackgroundTask,
  BackgroundTaskStatus,
  BackgroundTaskResult,
  Notification,
} from './background-tasks'

// Clarify 工具 (T9)
export { CLARIFY_TOOL_DEFINITION, executeClarify, setClarifyCallback } from './clarify-tool'
export type { ClarifyInput, ClarifyResult, ClarifyCallback } from './clarify-tool'

// Worktree 工具 (s12)
export {
  WorktreeManager,
  WorktreeConfig,
  WorktreeSession,
  getWorktreeManager,
  resetWorktreeManager,
  createWorktreeTool,
  createEnterWorktreeTool,
  createExitWorktreeTool,
} from './worktree'

// 初始化默认工具注册表
import { ToolRegistry } from './tool-registry'
import { bashTool } from './bash-tool'
import { createFileTools } from './file-tools'
import { globTool } from './glob-tool'
import { grepTool } from './grep-tool'
import { webSearchTool } from './web-search-tool'
import { webFetchTool } from './web-fetch-tool'
import { browserAdapterTool } from './browser-adapter'
import { agentTool } from './agent-tool'
import { scheduleTool } from './schedule-tool'
import { createSkillTool, createListSkillsTool } from '../skills/skill-tool'
import { createTodoTool, createStartTodoTool, createCompleteTodoTool } from './todo-tool'
import { createTaskTool, createReadyTasksTool } from './task-tool'
import { createBackgroundTool, createNotificationTool } from './background-tool'
import {
  createWorktreeTool,
  createEnterWorktreeTool,
  createExitWorktreeTool,
} from './worktree'
import { CLARIFY_TOOL_DEFINITION, executeClarify } from './clarify-tool'
import type { Tool } from './tool-interface'

/**
 * 创建并初始化默认工具注册表
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()

  // 基础工具
  registry.register(bashTool)
  registry.registerAll(createFileTools())

  // Phase 2 工具
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(webSearchTool)
  registry.register(webFetchTool)
  registry.register(browserAdapterTool)

  // Phase 3 工具
  registry.register(agentTool)
  registry.register(scheduleTool)

  // Skill 工具（使用免费模型）
  registry.register(createSkillTool())
  registry.register(createListSkillsTool())

  // Todo 工具（s03 任务追踪）
  registry.register(createTodoTool())
  registry.register(createStartTodoTool())
  registry.register(createCompleteTodoTool())

  // Task 工具（s07 持久化任务系统）
  registry.register(createTaskTool())
  registry.register(createReadyTasksTool())

  // Background 工具（s08 后台任务）
  registry.register(createBackgroundTool())
  registry.register(createNotificationTool())

  // Worktree 工具（s12 隔离工作树）
  registry.register(createWorktreeTool())
  registry.register(createEnterWorktreeTool())
  registry.register(createExitWorktreeTool())

  // Clarify 工具（T9 结构化多选题交互）
  registry.register({
    definition: CLARIFY_TOOL_DEFINITION as unknown as import('./tool-interface').ToolDefinition,
    async execute(params: Record<string, unknown>): Promise<import('./tool-interface').ToolResult> {
      const output = await executeClarify(params as any)
      return { success: true, output }
    },
  } as Tool)

  return registry
}

/**
 * 获取所有工具定义（用于 LLM 工具声明）
 */
export function getAllToolDefinitions() {
  const registry = createDefaultToolRegistry()
  return registry.getDefinitions()
}
