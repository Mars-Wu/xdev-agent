// src/core/agent-loop.ts
// Agent Loop —— 带工具调用的完整 while 循环
//
// 核心模式（来自 learn-claude-code s01）：
//   while stop_reason == "tool_use":
//     response = LLM(messages, tools)
//     execute tools
//     append results

import { createLogger } from '../utils/logger';
import type { LLMClient } from './llm-client';
import type { MessageHistoryManager, Message } from './message-history';
import type { ContentBlock } from './message-history';
import type { ToolRegistry } from '../tools/tool-registry';
import { microCompactMessages } from '../context/micro-compact';
import { getTodoManager } from '../tools/todo-manager';
import { getBackgroundTaskManager } from '../tools/background-tasks';

const logger = createLogger('agent-loop');

export const DEFAULT_MAX_TURNS = parseInt(process.env.XIAOZHI_MAX_TURNS || '30');

// p2-todo-reminder：超过此轮次未更新 todo，注入提醒
const TODO_REMINDER_INTERVAL = 3;

/** 构建 todo 提醒文本（若不需要则返回 null） */
function buildTodoReminder(roundsSince: number): string | null {
  if (roundsSince < TODO_REMINDER_INTERVAL) return null;
  try {
    const manager = getTodoManager();
    const inProgress = manager.getAllTodos().filter(t => t.status === 'in_progress');
    const pending = manager.getAllTodos().filter(t => t.status === 'pending');
    if (inProgress.length === 0 && pending.length === 0) return null;
    const items = [
      ...inProgress.map(t => `  [进行中] ${t.content}`),
      ...pending.slice(0, 3).map(t => `  [待处理] ${t.content}`),
    ].join('\n');
    return `<reminder>已经 ${roundsSince} 轮未更新 Todo。当前任务：\n${items}\n请更新 Todo 状态。</reminder>`;
  } catch {
    return null;
  }
}

/**
 * p3-notification-queue：drain 后台任务通知队列
 * 把未读通知作为 user 消息注入 history，让 Agent 感知后台任务完成情况。
 */
function drainBackgroundNotifications(historyManager: MessageHistoryManager): void {
  try {
    const manager = getBackgroundTaskManager();
    const unread = manager.getUnreadNotifications();
    if (unread.length === 0) return;
    const text = unread
      .map(n => `[后台任务${n.type === 'task_completed' ? '完成' : n.type === 'task_failed' ? '失败' : '通知'}] ${n.title}: ${n.content}`)
      .join('\n');
    historyManager.addMessage({ role: 'user', content: text });
    manager.markAllAsRead();
    logger.info(`[Agent Loop] 注入 ${unread.length} 条后台任务通知`);
  } catch {
    // 后台任务管理器未初始化时忽略
  }
}

/**
 * 运行带工具调用的 Agent Loop
 *
 * @param llmClient      LLM 客户端
 * @param historyManager 消息历史（含上下文）
 * @param systemPrompt   本次调用的系统提示词
 * @param toolRegistry   工具注册表（传 null 则纯对话模式）
 * @param maxTurns       最大循环轮次（硬上限，防止失控）
 * @returns 最后一次 LLM 文本回复
 */
export async function runAgentLoop(
  llmClient: LLMClient,
  historyManager: MessageHistoryManager,
  systemPrompt: string,
  toolRegistry: ToolRegistry | null,
  maxTurns = DEFAULT_MAX_TURNS,
): Promise<string> {
  const toolDefs = toolRegistry?.getDefinitions() ?? [];
  let turns = 0;
  let lastTextContent = '';
  let roundsSinceTodoUpdate = 0; // p2-todo-reminder

  while (turns < maxTurns) {
    turns++;

    // p3-notification-queue：注入后台任务通知（drain 未读队列）
    drainBackgroundNotifications(historyManager);

    // Micro-compact：每轮开始前截断旧 tool_result，避免上下文膨胀
    const messages = microCompactMessages(historyManager.getMessages()) as Message[];

    const response = await llmClient.chatSync({
      model: process.env.XIAOZHI_MODEL || 'glm-5',
      maxTokens: 16000,
      messages,
      system: systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
    });

    // 构建 ContentBlock[] 格式的 assistant 消息（混合 text + tool_use）
    const assistantContent: ContentBlock[] = [];
    if (response.content) {
      assistantContent.push({ type: 'text', text: response.content });
      lastTextContent = response.content;
    }
    for (const call of response.toolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
    historyManager.addMessage({ role: 'assistant', content: assistantContent });

    // 无工具调用 → 模型已完成，退出循环
    if (!response.toolCalls || response.toolCalls.length === 0) break;

    if (!toolRegistry) break;

    logger.info(`[Agent Loop] 第 ${turns} 轮，执行 ${response.toolCalls.length} 个工具`);

    // 执行所有工具调用，收集 tool_result
    const toolResults: ContentBlock[] = [];
    let todoUpdated = false;
    for (const call of response.toolCalls) {
      logger.info(`  → ${call.name}`);
      const result = await toolRegistry.execute(call.name, call.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.success
          ? (result.output || '(完成)')
          : `Error: ${result.error || '未知错误'}`,
        is_error: !result.success,
      });
      // 检查是否有 todo 更新操作
      if (/^todo/.test(call.name)) todoUpdated = true;
    }

    // p2-todo-reminder：追踪 todo 更新，到时注入提醒
    if (todoUpdated) {
      roundsSinceTodoUpdate = 0;
    } else {
      roundsSinceTodoUpdate++;
    }
    const reminder = buildTodoReminder(roundsSinceTodoUpdate);
    const userContent: ContentBlock[] = reminder
      ? [...toolResults, { type: 'text', text: reminder }]
      : toolResults;

    historyManager.addMessage({ role: 'user', content: userContent });
  }

  if (turns >= maxTurns) {
    logger.warn(`[Agent Loop] 达到最大轮次上限: ${maxTurns}，强制停止`);
  }

  return lastTextContent;
}
