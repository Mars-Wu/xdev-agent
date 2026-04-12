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
import { configManager } from '../config';
import { resetInterrupt } from '../utils/interrupt';
import { CheckpointManager } from '../tools/checkpoint-manager';
import { SubdirectoryHintTracker } from '../context/subdirectory-hints';

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
 * 规范化消息序列，确保符合 GLM API 要求：
 *   1. 序列必须以 user 消息开头
 *   2. user / assistant 必须严格交替（合并连续同角色消息）
 *
 * 压缩后的 recent 切片可能以 assistant 消息开头（agent loop 中途触发压缩），
 * 导致 GLM 返回 400/1214 "messages 参数非法"。
 */
export function normalizeMessages(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const result: Message[] = [];
  for (const msg of messages) {
    if (result.length === 0) {
      // 序列必须以 user 开头；跳过开头的 assistant 消息
      if (msg.role !== 'user') continue;
      result.push({ ...msg });
    } else {
      const last = result[result.length - 1];
      if (msg.role === last.role) {
        // 合并连续同角色消息的内容
        const lastContent = last.content;
        const newContent = msg.content;
        if (typeof lastContent === 'string' && typeof newContent === 'string') {
          last.content = `${lastContent}\n\n${newContent}`;
        } else {
          const blocks: ContentBlock[] = [
            ...(Array.isArray(lastContent) ? lastContent : [{ type: 'text' as const, text: lastContent }]),
            ...(Array.isArray(newContent) ? newContent : [{ type: 'text' as const, text: newContent }]),
          ];
          last.content = blocks;
        }
      } else {
        result.push({ ...msg });
      }
    }
  }

  // 末尾若以 assistant 结尾（工具调用被截断），追加一条空 user 占位，否则 API 会报错
  if (result.length > 0 && result[result.length - 1].role === 'assistant') {
    result.push({ role: 'user', content: '[context continues]' });
  }

  return result;
}

/**
 * 从历史消息中提取最后一条用户问题文本（用于回复选择器判断相关性）
 */
function getUserQuestion(historyManager: MessageHistoryManager): string {
  const messages = historyManager.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && typeof msg.content === 'string') {
      return msg.content;
    }
  }
  return '';
}

/**
 * 回复选择器：调用快速 LLM 判断哪一段候选文本最适合回复用户
 * 仅当候选文本超过 1 条时调用，失败则静默 fallback 到最后一条
 */
async function selectBestResponse(
  llmClient: LLMClient,
  userQuestion: string,
  candidates: string[],
): Promise<string | null> {
  if (candidates.length <= 1) return null;

  const candidateList = candidates
    .map((t, i) => `[${i + 1}]\n${t.slice(0, 600)}`)
    .join('\n\n');

  const prompt = `用户的问题是："${userQuestion.slice(0, 200)}"

以下是AI助手处理过程中产生的 ${candidates.length} 段文本，请选择最适合直接回复用户的那段（信息量最大、最直接回答问题、不是"已完成"之类的完成确认）：

${candidateList}

只输出一个数字（1 到 ${candidates.length}），不要其他内容。`;

  try {
    const selectorModel = configManager.getConfig().model.selectorModel;
    const response = await llmClient.chatSync({
      model: selectorModel,
      maxTokens: 10,
      messages: [{ role: 'user', content: prompt }],
      system: '你是回复质量评估员，只输出数字。',
    });
    const num = parseInt(response.content?.trim() ?? '', 10);
    if (num >= 1 && num <= candidates.length) {
      logger.info(`[Agent Loop] 回复选择器选中第 ${num} 段（共 ${candidates.length} 段候选，模型: ${selectorModel}）`);
      return candidates[num - 1];
    }
    logger.warn(`[Agent Loop] 回复选择器返回无效数字: "${response.content}"，使用最后一段`);
  } catch (err) {
    logger.warn(`[Agent Loop] 回复选择器调用失败，降级到最后一段: ${err}`);
  }
  return null;
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
  const candidateTexts: string[] = [];  // 每轮有实质文本时收集，供选择器使用
  let roundsSinceTodoUpdate = 0; // p2-todo-reminder

  // T5: 影子 Git 检查点管理器（每轮写操作后自动快照）
  const checkpointMgr = new CheckpointManager(process.cwd());
  let hadWriteOperation = false;
  let checkpointLabel = 'agent work'; // 记录触发写操作时的任务描述

  // T6: 子目录上下文懒加载
  const hintTracker = new SubdirectoryHintTracker(process.cwd());

  while (turns < maxTurns) {
    turns++;
    resetInterrupt(); // T10: 每轮开始时重置中断信号，防止上轮残留

    // T5: 若上一轮有写操作，创建检查点快照（异步，不阻塞）
    if (hadWriteOperation) {
      hadWriteOperation = false;
      checkpointMgr.createCheckpoint(`turn-${turns - 1}: ${checkpointLabel}`).catch(() => {});
      checkpointLabel = 'agent work';
    }

    // p3-notification-queue：注入后台任务通知（drain 未读队列）
    drainBackgroundNotifications(historyManager);

    // Micro-compact：每轮开始前截断旧 tool_result，避免上下文膨胀
    const allMessages = microCompactMessages(historyManager.getMessages()) as Message[];

    // GLM API 只接受 user/assistant role；system 消息（历史摘要）合并进 system prompt
    const systemMessages = allMessages.filter(m => m.role === 'system');
    const rawMessages = allMessages.filter(m => m.role !== 'system');
    // 规范化：确保序列以 user 开头且 user/assistant 严格交替（压缩后可能违反）
    const messages = normalizeMessages(rawMessages);
    const summaryContent = systemMessages
      .map(m => typeof m.content === 'string' ? m.content : '')
      .filter(Boolean)
      .join('\n\n');
    const fullSystemPrompt = summaryContent
      ? `${systemPrompt}\n\n${summaryContent}`
      : systemPrompt;

    const response = await llmClient.chatSync({
      model: configManager.getConfig().model.defaultModel,
      maxTokens: 16000,
      messages,
      system: fullSystemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
    });

    // 构建 ContentBlock[] 格式的 assistant 消息（混合 text + tool_use）
    const assistantContent: ContentBlock[] = [];
    if (response.content) {
      assistantContent.push({ type: 'text', text: response.content });
      lastTextContent = response.content;
      // 收集非空文本作为候选（长度 > 20 才算实质内容）
      if (response.content.trim().length > 20) {
        candidateTexts.push(response.content);
      }
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

      // T5: 检测写操作（write/edit 工具），下轮触发检查点；同时记录当前用户请求作为描述
      if (/^(?:write|edit)$/.test(call.name)) {
        hadWriteOperation = true;
        // 记录触发写操作时的最新用户消息（此时 turn N 的消息已在 history 中）
        const latestUserMsg = historyManager.getMessages()
          .filter(m => m.role === 'user' && typeof m.content === 'string')
          .at(-1);
        checkpointLabel = typeof latestUserMsg?.content === 'string'
          ? latestUserMsg.content.slice(0, 80)
          : 'agent work';
      }

      // T6: 检查工具调用路径，若访问新子目录则注入上下文提示
      const hints = hintTracker.checkToolCall(call.name, call.input as Record<string, unknown>);
      const toolOutput = result.success
        ? (result.output || '(完成)')
        : `Error: ${result.error || '未知错误'}`;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: hints ? toolOutput + hints : toolOutput,
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

  // 多轮次有文本时，调用快速 LLM 选择最适合回复用户的那段
  if (candidateTexts.length > 1) {
    const userQuestion = getUserQuestion(historyManager);
    const selected = await selectBestResponse(llmClient, userQuestion, candidateTexts);
    if (selected) return selected;
  }

  return lastTextContent;
}
