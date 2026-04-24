// src/index.ts
// AI管家艾克斯 - 入口
// 架构: Gateway + 插件系统 + SDK 直连

import 'dotenv/config';
import { FeishuClient } from './feishu/client';
import { HooksReceiver } from './api/hooks-receiver';
import { SQLiteStorage } from './storage/sqlite';
import { MemoryMonitor } from './monitor/memory-monitor';
import { createLogger, setLogLevel } from './utils/logger';
import { PATHS, configManager } from './config';
import { GatewayServer, createGatewayServer } from './gateway';
import { PluginManager, createPluginManager, eventBus, EventTypes } from './plugin-sdk';
import {
  LLMClient,
  getLLMClient,
  MessageHistoryManager,
  modelSelector,
  modelCapabilitiesManager,
} from './core';
import { createPromptBuilder, MemoryItem } from './prompt';
import { getMemoryManager, MemoryManager } from './memory';
import { initializeSkillRegistry, getSkillRegistry } from './skills';
import { createDefaultToolRegistry, ToolRegistry } from './tools';
import { runAgentLoop, DEFAULT_MAX_TURNS } from './core/agent-loop';
import { getTopicGraph } from './storage/topic-graph';
import { routeAndAssemble, type ContinuityContext, type RecentTurnSignal } from './core/message-router';
import { createTopicTools } from './tools/topic-tools';
import { triggerBackgroundPass, buildExecutionSummary, triggerMemoryExtraction } from './core/background-memory';
import { startLintScheduler } from './core/memory-lint-scheduler';
import { analyzeImage, detectMimeType } from './core/vision';
import { autoGenerateTitle } from './core/title-generator';
import { executeClarify, setClarifyCallback } from './tools/clarify-tool';
import { ChatSessionState } from './core/chat-session-state';
import { buildOversizeMessageNotice, shouldRejectIncomingMessage } from './core/message-guard';
import { CardBuilder } from './feishu/card-builder';
import { AsyncLocalStorage } from 'async_hooks';
// session 模块已移除 - 使用记忆系统替代
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { detectStructuredClarifyPrompt } from './core/message-heuristics';
import { rewriteStructuredClarifyResolution } from './core/message-heuristics';

const logger = createLogger('main');

// Gateway 配置
const GATEWAY_PORT = parseInt(process.env.XDEV_GATEWAY_PORT || '18789');
const GATEWAY_HOST = process.env.XDEV_GATEWAY_HOST || '127.0.0.1';

// 消息长度限制（防止 DoS）
const MAX_MESSAGE_LENGTH = parseInt(process.env.XDEV_MAX_MESSAGE_LENGTH || '10000');
const MAX_MESSAGE_DISPLAY = 500; // 错误提示中显示的最大长度

// Agent Loop 最大轮次由 XDEV_MAX_TURNS 环境变量控制（默认 30），见 src/core/agent-loop.ts

// AsyncLocalStorage 安全传递当前消息的 chatId（并发安全，无全局变量竞争）
const chatIdStorage = new AsyncLocalStorage<string>();
const chatSessionState = new ChatSessionState();

function parseClarifyToolResponse(payload: string): { userResponse?: string; error?: string } {
  try {
    const parsed = JSON.parse(payload) as { user_response?: string; error?: string };
    return {
      userResponse: typeof parsed.user_response === 'string' ? parsed.user_response.trim() : undefined,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * 验证必需的环境变量
 */
function validateConfig(): void {
  const missing: string[] = [];

  // 检查 API Key（支持两种环境变量名）
  const hasApiKey = process.env.ZHIPU_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  if (!hasApiKey) {
    missing.push('ZHIPU_API_KEY 或 ANTHROPIC_AUTH_TOKEN (智谱 API Key)')
  }

  // 检查飞书配置
  if (!process.env.FEISHU_APP_ID) {
    missing.push('FEISHU_APP_ID (飞书应用 ID)')
  }
  if (!process.env.FEISHU_APP_SECRET) {
    missing.push('FEISHU_APP_SECRET (飞书应用密钥)')
  }

  if (missing.length > 0) {
    logger.error('==========================================')
    logger.error('配置验证失败: 缺少必需的环境变量')
    logger.error('==========================================')
    for (const item of missing) {
      logger.error(`  - ${item}`)
    }
    logger.error('')
    logger.error('请在 .env 文件或环境变量中设置这些值')
    logger.error('==========================================')
    process.exit(1)
  }

  // 验证格式
  if (process.env.FEISHU_APP_ID && !process.env.FEISHU_APP_ID.startsWith('cli_')) {
    logger.warn('FEISHU_APP_ID 格式可能不正确（通常以 cli_ 开头）')
  }

  // 验证配置 Schema
  const validation = configManager.validate()
  if (!validation.valid) {
    logger.error('配置验证失败:')
    for (const error of validation.errors) {
      logger.error(`  - ${error}`)
    }
    process.exit(1)
  }

  logger.info('配置验证通过')
}

/**
 * 初始化目录结构
 */
async function initializeDirectories(): Promise<void> {
  const dirs = [
    PATHS.XDEV_HOME,
    PATHS.WORKSPACE,
    PATHS.SESSIONS_DIR,
    PATHS.MEMORY_DIR,
    PATHS.TEAMS_DIR,
    PATHS.CACHE_DIR,
    PATHS.LOGS_DIR,
    path.join(PATHS.CACHE_DIR, 'prompts'),
    path.join(PATHS.SESSIONS_DIR, 'archive'),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  logger.info('目录结构已初始化');
}

async function main() {
  const xdevConfig = configManager.getConfig();
  setLogLevel(xdevConfig.log.level);

  // 配置验证
  validateConfig();

  logger.info('AI管家艾克斯启动中...');
  logger.info('==========================================');
  logger.info('架构: Gateway + 插件系统 + SDK 直连');
  logger.info('==========================================');

  const xdevHome = PATHS.XDEV_HOME;
  const hooksPort = parseInt(process.env.XDEV_HOOKS_PORT || '8081');

  logger.info(`xdevHome: ${xdevHome}`);
  logger.info(`os.homedir(): ${os.homedir()}`);

  // 初始化目录
  await initializeDirectories();

  const config = {
    compactThreshold: parseInt(process.env.XDEV_COMPACT_THRESHOLD || '') || 5 * 1024 * 1024,
    timeout: parseInt(process.env.API_TIMEOUT_MS || process.env.XDEV_TIMEOUT || '') || xdevConfig.timeout?.apiTimeout || 300000,
    maxRetries: parseInt(process.env.XDEV_MAX_RETRIES || '') || 3,
    retryDelay: parseInt(process.env.XDEV_RETRY_DELAY || '') || 1000,
    autoCompact: process.env.XDEV_AUTO_COMPACT === 'true',
  };

  logger.info('配置参数:');
  logger.info(`  - 压缩阈值: ${formatBytes(config.compactThreshold)}`);
  logger.info(`  - 请求超时: ${config.timeout / 1000}s`);
  logger.info(`  - 最大重试: ${config.maxRetries} 次`);

  // 1. 数据存储
  const storage = new SQLiteStorage(PATHS.DB_PATH);

  // 2. 初始化 LLM 客户端
  const llmClient = getLLMClient({
    apiKey: process.env.ZHIPU_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL:
      process.env.ZHIPU_API_BASE_URL
      || process.env.GLM_BASE_URL
      || process.env.ANTHROPIC_BASE_URL
      || 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: xdevConfig.model.defaultModel,
    defaultMaxTokens: 16000,
    timeout: config.timeout,
  });
  logger.info('LLM 客户端已初始化');

  // 3. Gateway 服务器
  const gateway = createGatewayServer({
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
  });

  // 4. 插件管理器
  const pluginManager = createPluginManager({
    pluginsDir: path.join(xdevHome, 'plugins'),
    autoLoad: true,
  });
  await pluginManager.initialize();
  logger.info(`插件管理器已初始化`);

  // 4.5 Skill 注册表
  await initializeSkillRegistry();
  const skillRegistry = getSkillRegistry();
  logger.info(`Skill 注册表已初始化，已加载 ${skillRegistry.size()} 个技能`);

  // 4.6 工具注册表（为 Agent Loop 提供工具集）
  const toolRegistry = createDefaultToolRegistry();
  logger.info(`工具注册表已初始化，已加载 ${toolRegistry.getDefinitions().length} 个工具`);

  // 5. HTTP 接收器
  const hooksReceiver = new HooksReceiver();
  hooksReceiver.setLLMClient(llmClient);
  hooksReceiver.listen(hooksPort);
  logger.info(`HTTP接收器已启动，端口 ${hooksPort}`);

  // 6. 内存监控
  const memoryMonitor = new MemoryMonitor(`http://localhost:${hooksPort}/api/callbacks/complete`);
  memoryMonitor.start();

  // 7. 飞书客户端
  const feishuClient = new FeishuClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    useWebSocket: process.env.FEISHU_USE_WEBSOCKET !== 'false',
  });

  // 8. 全局 historyManager（降级备用，话题路由启动失败时使用）
  const historyManager = new MessageHistoryManager({
    maxMessages: 1000,
    maxTokens: 180_000,
    preserveRecent: 10,
    enableCompression: true,
    compressionThreshold: 0.9,
  });
  hooksReceiver.setHistoryManager(historyManager);

  // 8.1 预初始化话题图（提前建表，避免首条消息延迟）
  getTopicGraph();
  logger.info('话题路由已启用');

  // 8.2 启动记忆 Lint 调度器（每 lintIntervalDays 天后台健康检查）
  startLintScheduler(llmClient, getMemoryManager(), getTopicGraph());

  // 9. 消息处理
  feishuClient.setMessageHandler(async (msg) => {
    // T9: 若有 pending clarify 等待，将此条消息作为回复而非新任务
    if (chatSessionState.consumePendingReply(msg.chatId, msg.content)) {
      return;
    }
    // 用 AsyncLocalStorage 将 chatId 绑定到整个异步调用链，并发安全（无全局变量竞争）
    await chatSessionState.enqueue(msg.chatId, () =>
      chatIdStorage.run(msg.chatId, () =>
        handleMessage(msg, llmClient, feishuClient, historyManager, storage, toolRegistry),
      ),
    );
  });

  // 9.1 注入全流程测试管道（/test/message 端点使用）
  // 构造和真实飞书消息完全相同的 FeishuMessage，走同一条处理链路，回复照常发往飞书
  hooksReceiver.setMessagePipeline(async (chatId: string, content: string) => {
    const fakeMsg: import('./feishu/types').FeishuMessage = {
      messageId: `test_${Date.now()}`,
      chatId,
      userId: 'test-user',
      content,
      msgType: 'text',
      timestamp: new Date(),
    };
    await chatSessionState.enqueue(chatId, () =>
      chatIdStorage.run(chatId, () =>
        handleMessage(fakeMsg, llmClient, feishuClient, historyManager, storage, toolRegistry),
      ),
    );
  });

  // T9: 注入 Clarify 飞书回调（在 feishuClient 初始化后设置）
  setClarifyCallback(async (question: string, choices: string[] | null) => {
    // 从 AsyncLocalStorage 读取当前异步链的 chatId（并发安全）
    const chatId = chatIdStorage.getStore();
    if (!chatId) throw new Error('Clarify 工具：当前无活跃会话 chatId');

    if (choices && choices.length > 0) {
      // 有选项：使用互动卡片按钮
      const builder = new CardBuilder({ title: '❓ 需要确认', color: 'yellow' })
        .addMarkdown(question)
        .addDivider();
      for (const choice of choices) {
        builder.addButton({
          text: choice,
          type: 'default',
          value: { clarify_reply: choice, clarify_chat_id: chatId },
        });
      }
      builder.addButton({
        text: '其他（请直接回复）',
        type: 'default',
        value: { clarify_reply: '__other__', clarify_chat_id: chatId },
      });
      await feishuClient.sendCard(chatId, builder.build() as any);
    } else {
      // 无选项：发送富文本开放式问题
      await feishuClient.sendMessage(chatId, {
        content: `**❓ ${question}**\n\n请直接回复您的答案。`,
        type: 'post',
      });
    }
    return chatSessionState.waitForReply(chatId, 60_000);
  });

  // 卡片按钮点击处理（Clarify 工具的选项按钮）
  feishuClient.setCardActionHandler(async (chatId, actionValue) => {
    const reply = actionValue.clarify_reply;
    if (typeof reply !== 'string') return;
    // "__other__" 表示用户点了"其他"，等待下条文字消息，不立即 resolve
    if (reply === '__other__') return;
    chatSessionState.consumePendingReply(chatId, reply);
  });

  // 10. 设置 Gateway 依赖注入
  gateway.setPluginManager({
    getStats: () => pluginManager.getStats(),
    getPlugins: () => {
      const stats = pluginManager.getStats();
      return [{
        name: 'feishu',
        version: '1.0.0',
        enabled: true,
        status: 'loaded',
      }];
    },
  });
  gateway.setConfigManager({
    getConfig: () => configManager.getConfig() as unknown as Record<string, unknown>,
  });
  gateway.setChannelStatus({
    getChannels: () => [{
      name: 'feishu',
      type: 'websocket',
      connected: true,
    }],
  });
  // Chat 通道已废弃：请通过飞书直接与艾克斯对话
  logger.info('Gateway 依赖已设置');

  // 11. 启动 Gateway
  await gateway.start();
  logger.info(`Gateway 已启动: ws://${GATEWAY_HOST}:${GATEWAY_PORT}`);

  // 12. 启动核心服务
  await feishuClient.start();

  // 注册事件监听
  eventBus.on(EventTypes.MESSAGE_RECEIVED, (data) => {
    gateway.broadcast({
      type: 'message:received',
      data,
      timestamp: Date.now(),
    });
  });

  // 显示启动信息
  const pluginStats = pluginManager.getStats();
  const models = modelCapabilitiesManager.listAll();

  logger.info('==========================================');
  logger.info('可用模型:');
  for (const model of models) {
    logger.info(`  - ${model.name} (${model.id}): ${model.contextWindow / 1000}K 上下文`);
  }
  logger.info(`插件: ${pluginStats.total} 个已加载`);
  logger.info('==========================================');
  logger.info('飞书入口 slash 命令: 暂未启用（收到 /... 会返回“未知命令”）');
  logger.info('==========================================');
  logger.info('Gateway 端点:');
  logger.info(`  - WebSocket: ws://${GATEWAY_HOST}:${GATEWAY_PORT}`);
  logger.info(`  - Health:    http://${GATEWAY_HOST}:${GATEWAY_PORT}/health`);
  logger.info('==========================================');
  logger.info('AI管家艾克斯已就绪');

  // 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info(`收到${signal}，正在关闭...`);

    // 1. 停止接收新消息
    await feishuClient.stop();

    // 2. 关闭 Gateway
    await gateway.stop();

    // 3. 关闭插件
    await pluginManager.shutdown();

    // 4. 关闭其他组件
    memoryMonitor.stop();
    hooksReceiver.close();
    storage.close();

    logger.info('AI管家艾克斯已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// "正在思考"提示的超时阈值（毫秒）
const THINKING_PROMPT_DELAY = 2000;

/**
 * 处理飞书消息
 */
async function handleMessage(
  msg: import('./feishu/types').FeishuMessage,
  llmClient: LLMClient,
  feishuClient: FeishuClient,
  historyManager: MessageHistoryManager,
  storage: SQLiteStorage,
  toolRegistry: ToolRegistry,
): Promise<void> {
  try {
    const rawContent = msg.content.trim();
    let content = rawContent;

    if (msg.msgType !== 'image') {
      const clarifyPrompt = detectStructuredClarifyPrompt(content);
      if (clarifyPrompt) {
        const clarifyResult = parseClarifyToolResponse(await executeClarify(clarifyPrompt));
        if (clarifyResult.error) {
          await feishuClient.sendMessage(msg.chatId, {
            content: `澄清失败: ${clarifyResult.error}`,
            type: 'text',
          });
          return;
        }
        if (clarifyResult.userResponse) {
          content = rewriteStructuredClarifyResolution(content, clarifyResult.userResponse);
        }
      }
    }

    // ── 图片消息：下载后用 GLM-4V 分析，将识别结果注入对话 ──────────────
    let imageDescription: string | null = null;
    if (msg.msgType === 'image' && msg.imageKey && msg.messageId) {
      try {
        const imgBuffer = await feishuClient.downloadFile(msg.imageKey, msg.messageId, 'image');
        const mediaType = detectMimeType(imgBuffer);
        logger.info(`图片已下载: ${msg.imageKey} (${(imgBuffer.length / 1024).toFixed(1)}KB, ${mediaType})`);
        // 用户可能同时附带文字（飞书图片消息的 content 字段）
        const userQuestion = content && content !== '[图片]' ? content : undefined;
        imageDescription = await analyzeImage(imgBuffer, mediaType, userQuestion);
      } catch (err) {
        logger.warn('图片分析失败，降级为文本处理:', err);
        imageDescription = '[图片分析失败，请重新发送]';
      }
    }

    // P0 修复：消息长度验证（防止 DoS）；图片消息 content 是 '[图片]'，跳过长度检查
    if (msg.msgType !== 'image' && shouldRejectIncomingMessage(content, MAX_MESSAGE_LENGTH)) {
      await feishuClient.sendMessage(msg.chatId, {
        content: buildOversizeMessageNotice(content, MAX_MESSAGE_LENGTH, MAX_MESSAGE_DISPLAY),
        type: 'text',
      });
      logger.warn(`消息过长被拒绝: ${content.length} 字符 (限制: ${MAX_MESSAGE_LENGTH})`);
      return;
    }

    // 检查是否为命令（以 / 开头）；图片消息跳过
    if (msg.msgType !== 'image' && content.startsWith('/')) {
      // 命令处理...
      await feishuClient.sendMessage(msg.chatId, {
        content: `未知命令: ${content}`,
        type: 'text',
      });
      return;
    }

    // 记录收到的消息
    if (msg.msgType === 'image') {
      logger.info(`收到飞书图片消息: imageKey=${msg.imageKey}`);
    } else {
      logger.info(`收到飞书消息: ${rawContent.slice(0, 100)}${rawContent.length > 100 ? '...' : ''}`);
    }

    // 智能等待提示：只在响应较慢时才显示
    const thinkingTimer = setTimeout(async () => {
      try {
        await feishuClient.sendMessage(msg.chatId, {
          content: '💭 正在思考...',
          type: 'text',
        });
      } catch {
        // 忽略发送失败
      }
    }, THINKING_PROMPT_DELAY);

    try {
      // ── 3 阶段话题路由流水线 ──────────────────────────────────────────
      const memoryManager = getMemoryManager();
      await memoryManager.initialize();
      const topicGraph = getTopicGraph();

      let replyText: string;

      try {
        // Stage 1：路由 + Context 组装（返回数组，单话题长度=1）
        const contexts = await routeAndAssemble(
          content,
          topicGraph,
          llmClient,
          memoryManager,
          chatSessionState.getContinuityContext(msg.chatId),
        );

        // Stage 2：对每个话题并行执行 Agent Loop
        const subResponses = await Promise.all(
          contexts.map(async (context) => {
            try {
              // 将子问题追加到话题 history bucket（图片消息注入视觉分析文字）
              const userText = imageDescription
                ? `[主人@飞书 发送了一张图片]\n\n**图片内容分析**:\n${imageDescription}${context.subMessage && context.subMessage !== '[图片]' ? `\n\n**用户问题**: ${context.subMessage}` : ''}`
                : `[主人@飞书] ${context.subMessage}`;
              context.topicHistory.addMessage({
                role: 'user',
                content: userText,
              });

              // 注册话题专属工具（save_memory / update_topic_summary）
              const topicTools = createTopicTools(memoryManager, topicGraph, context.topicId);
              topicTools.forEach(t => {
                toolRegistry.unregister(t.definition.name);
                toolRegistry.register(t);
              });

              // 构建 system prompt（传入话题 ID 过滤不相关记忆）
              const basePrompt = await buildSystemPrompt(storage, context.topicId);
              const systemPrompt = context.systemPrompt
                ? `${basePrompt}\n\n${context.systemPrompt}`
                : basePrompt;

              // Agent Loop（使用话题 history bucket）
              const reply = await runAgentLoop(
                llmClient,
                context.topicHistory,
                systemPrompt,
                toolRegistry,
              );

              // 保存话题 history（持久化到磁盘）
              topicGraph.saveHistory(context.topicId, context.topicHistory);
              topicGraph.incrementTurnCount(context.topicId);

              // 修复：新话题立即写入初始摘要，防止下次消息因「无摘要」被错误分配新话题
              // （LLM 的 update_topic_summary 工具是可选的，不能依赖它来设置第一条摘要）
              if (context.route.isNewTopic) {
                const initialSummary = context.subMessage.slice(0, 150);
                topicGraph.updateSummary(context.topicId, initialSummary);
                logger.info(`[话题路由] 新话题 ${context.topicId} 初始摘要已写入: "${initialSummary.slice(0, 50)}..."`);
              }

              // T12: 异步生成话题标题（前2轮触发，不阻塞回复）
              autoGenerateTitle(
                context.subMessage,
                reply,
                context.topicHistory.getMessageCount(),
                (title) => topicGraph.updateTitle(context.topicId, title),
              );

              // 写 pipeline 日志
              topicGraph.logPipeline({
                ts: Date.now(),
                msgPreview: context.subMessage.slice(0, 50),
                topicId: context.topicId,
                isNewTopic: context.route.isNewTopic,
                confidence: context.route.confidence,
                historyStrategy: context.route.historyStrategy,
                contextTokens: context.topicHistory.stats().estimatedTokens,
              });

              // 异步触发 Background Pass（不阻塞回复）
              const executionSummary = buildExecutionSummary(context.topicHistory.getMessages());
              triggerBackgroundPass(
                { topicId: context.topicId, executionSummary },
                llmClient, topicGraph, memoryManager,
              );

              // 异步触发记忆提取（preference/feedback/convention/decision）
              triggerMemoryExtraction(
                { topicId: context.topicId, messages: context.topicHistory.getMessages() },
                memoryManager,
              );

              return { reply, error: null };
            } catch (subErr) {
              logger.warn(`话题 ${context.topicId} 处理失败:`, subErr);
              return { reply: '', error: '该部分处理失败，请稍后重试' };
            }
          })
        );

        // 合并回复（单话题直接返回，多话题用分隔线拼接）
        if (subResponses.length === 1) {
          const r = subResponses[0];
          replyText = r.error ? r.error : (r.reply || '(任务完成)');
        } else {
          replyText = subResponses
            .map(r => r.error ? `（${r.error}）` : r.reply)
            .filter(Boolean)
            .join('\n\n---\n\n') || '(任务完成)';
        }

        if (contexts.length === 1 && !contexts[0].isFallback) {
          const result = subResponses[0];
          if (!result.error && result.reply) {
            chatSessionState.rememberChatTurn(msg.chatId, {
              topicId: contexts[0].topicId,
              userMessage: content,
              assistantReply: result.reply,
              timestamp: Date.now(),
            });
          }
        }

      } catch (routingErr) {
        // 话题路由失败时降级到全局 historyManager（服务不中断）
        logger.warn('话题路由失败，降级为全局 history:', routingErr);
        const fallbackText = imageDescription
          ? `[主人@飞书 发送了一张图片]\n\n**图片内容分析**:\n${imageDescription}${content && content !== '[图片]' ? `\n\n**用户问题**: ${content}` : ''}`
          : `[主人@飞书] ${content}`;
        historyManager.addMessage({
          role: 'user',
          content: fallbackText,
        });
        const systemPrompt = await buildSystemPrompt(storage);  // 降级无话题 ID，注入通用记忆
        replyText = await runAgentLoop(llmClient, historyManager, systemPrompt, toolRegistry);
      }

      // 清除等待提示定时器
      clearTimeout(thinkingTimer);

      // 记录 LLM 回复（截取前 200 字符）
      const replyPreview = replyText.slice(0, 200);
      logger.info(`Agent 回复: ${replyPreview}${replyText.length > 200 ? '...' : ''}`);

      // Stage 3：发送回复
      await feishuClient.sendMessage(msg.chatId, {
        content: replyText || '(任务完成)',
        type: 'post',
      });
    } finally {
      // 确保定时器被清除
      clearTimeout(thinkingTimer);
    }
  } catch (error) {
    logger.error('处理消息失败:', error);
    await feishuClient.sendMessage(msg.chatId, {
      content: `处理失败: ${error instanceof Error ? error.message : String(error)}`,
      type: 'text',
    }).catch(() => {});
  }
}

/**
 * 构建系统提示词
 */
async function buildSystemPrompt(storage: SQLiteStorage, currentTopicId?: string): Promise<string> {
  const builder = createPromptBuilder()

  // 注入记忆 - 话题感知过滤，避免跨项目污染
  try {
    const memoryManager = getMemoryManager()
    await memoryManager.initialize()
    const memories = await memoryManager.getImportantMemories(15, currentTopicId)
    if (memories.length > 0) {
      const memoryItems: MemoryItem[] = memories.map(m => ({
        key: m.id || '',
        value: m.content,
        importance: m.importance || 5,
        timestamp: m.createdAt || Date.now(),
      }))
      builder.setMemories(memoryItems)
    }
  } catch (err) {
    // 记忆读取失败，使用基础提示词
    logger.warn('读取记忆失败，使用基础提示词:', err)
  }

  let prompt = builder.build({ includeMemory: true })

  // p1-skill-lazy：动态注入已注册技能的名称+描述（两层懒加载 Layer 1）
  // 只列出技能菜单，不注入完整 body；完整实现通过 use_skill 工具按需加载
  try {
    const skillRegistry = getSkillRegistry()
    const skills = skillRegistry.list()
    if (skills.length > 0) {
      const menu = skills
        .map(s => `  - ${s.name}${s.description ? ': ' + s.description : ''}`)
        .join('\n')
      prompt += `\n\n## 可用技能（通过 use_skill 工具调用）\n${menu}`
    }
  } catch (err) {
    // 技能注册表读取失败，忽略
    logger.warn('读取技能注册表失败:', err)
  }

  return prompt
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

main().catch((error) => {
  logger.error('启动失败:', error);
  process.exit(1);
});
