// src/index.ts
// AI管家小智 - 入口
// 架构: Gateway + 插件系统 + SDK 直连

import 'dotenv/config';
import { FeishuClient } from './feishu/client';
import { HooksReceiver } from './api/hooks-receiver';
import { SQLiteStorage } from './storage/sqlite';
import { MemoryMonitor } from './monitor/memory-monitor';
import { createLogger } from './utils/logger';
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
import { getPromptBuilder, MemoryItem } from './prompt';
import { getMemoryManager, MemoryManager } from './memory';
import { initializeSkillRegistry, getSkillRegistry } from './skills';
import { createDefaultToolRegistry, ToolRegistry } from './tools';
import { runAgentLoop, DEFAULT_MAX_TURNS } from './core/agent-loop';
import { getTopicGraph } from './storage/topic-graph';
import { routeAndAssemble } from './core/message-router';
import { createTopicTools } from './tools/topic-tools';
import { triggerBackgroundPass, buildExecutionSummary } from './core/background-memory';
// session 模块已移除 - 使用记忆系统替代
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

const logger = createLogger('main');

// Gateway 配置
const GATEWAY_PORT = parseInt(process.env.XIAOZHI_GATEWAY_PORT || '18789');
const GATEWAY_HOST = process.env.XIAOZHI_GATEWAY_HOST || '127.0.0.1';

// 消息长度限制（防止 DoS）
const MAX_MESSAGE_LENGTH = parseInt(process.env.XIAOZHI_MAX_MESSAGE_LENGTH || '100000'); // 100KB 文本
const MAX_MESSAGE_DISPLAY = 500; // 错误提示中显示的最大长度

// Agent Loop 最大轮次由 XIAOZHI_MAX_TURNS 环境变量控制（默认 30），见 src/core/agent-loop.ts

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
    PATHS.XIAOZHI_HOME,
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
  // 配置验证
  validateConfig();

  logger.info('AI管家小智启动中...');
  logger.info('==========================================');
  logger.info('架构: Gateway + 插件系统 + SDK 直连');
  logger.info('==========================================');

  const xiaozhiHome = PATHS.XIAOZHI_HOME;
  const hooksPort = parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081');

  logger.info(`xiaozhiHome: ${xiaozhiHome}`);
  logger.info(`os.homedir(): ${os.homedir()}`);

  // 初始化目录
  await initializeDirectories();

  // 配置参数 - 使用统一的配置管理器
  const xiaozhiConfig = configManager.getConfig();

  const config = {
    compactThreshold: parseInt(process.env.XIAOZHI_COMPACT_THRESHOLD || '') || 5 * 1024 * 1024,
    timeout: parseInt(process.env.API_TIMEOUT_MS || process.env.XIAOZHI_TIMEOUT || '') || xiaozhiConfig.timeout?.apiTimeout || 300000,
    maxRetries: parseInt(process.env.XIAOZHI_MAX_RETRIES || '') || 3,
    retryDelay: parseInt(process.env.XIAOZHI_RETRY_DELAY || '') || 1000,
    autoCompact: process.env.XIAOZHI_AUTO_COMPACT === 'true',
  };

  logger.info('配置参数:');
  logger.info(`  - 压缩阈值: ${formatBytes(config.compactThreshold)}`);
  logger.info(`  - 请求超时: ${config.timeout / 1000}s`);
  logger.info(`  - 最大重试: ${config.maxRetries} 次`);

  // 1. 数据存储
  const storage = new SQLiteStorage(PATHS.DB_PATH);

  // 2. 初始化 LLM 客户端
  const llmClient = getLLMClient({
    apiKey: process.env.ZHIPU_API_KEY,
    baseURL: process.env.ZHIPU_API_BASE_URL || 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: process.env.XIAOZHI_MODEL || 'glm-5',
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
    pluginsDir: path.join(xiaozhiHome, 'plugins'),
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
  hooksReceiver.listen(hooksPort);
  logger.info(`HTTP接收器已启动，端口 ${hooksPort}`);

  // 6. 内存监控
  const memoryMonitor = new MemoryMonitor(`http://localhost:${hooksPort}/api/callbacks/complete`);
  memoryMonitor.start();

  // 7. 飞书客户端
  const feishuClient = new FeishuClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    useWebSocket: true,
  });

  // 8. 全局 historyManager（降级备用，话题路由启动失败时使用）
  const historyManager = new MessageHistoryManager({
    maxMessages: 1000,
    maxTokens: 180_000,
    preserveRecent: 10,
    enableCompression: true,
    compressionThreshold: 0.9,
  });

  // 8.1 预初始化话题图（提前建表，避免首条消息延迟）
  getTopicGraph();
  logger.info('话题路由已启用');

  // 9. 消息处理
  feishuClient.setMessageHandler(async (msg) => {
    await handleMessage(msg, llmClient, feishuClient, historyManager, storage, toolRegistry);
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
  // Chat 通道已废弃：请通过飞书直接与小智对话
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
  logger.info('可用命令:');
  logger.info('  /compact  - 压缩会话上下文');
  logger.info('  /stats    - 查看会话统计');
  logger.info('  /health   - 健康检查');
  logger.info('  /reset    - 重置会话');
  logger.info('  /model    - 切换模型');
  logger.info('==========================================');
  logger.info('Gateway 端点:');
  logger.info(`  - WebSocket: ws://${GATEWAY_HOST}:${GATEWAY_PORT}`);
  logger.info(`  - Health:    http://${GATEWAY_HOST}:${GATEWAY_PORT}/health`);
  logger.info('==========================================');
  logger.info('AI管家小智已就绪');

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

    logger.info('AI管家小智已停止');
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
    const content = msg.content.trim();

    // P0 修复：消息长度验证（防止 DoS）
    if (content.length > MAX_MESSAGE_LENGTH) {
      const preview = content.slice(0, MAX_MESSAGE_DISPLAY);
      await feishuClient.sendMessage(msg.chatId, {
        content: `消息过长，已拒绝处理。\n长度: ${content.length} 字符\n限制: ${MAX_MESSAGE_LENGTH} 字符\n\n消息预览:\n${preview}...`,
        type: 'text',
      });
      logger.warn(`消息过长被拒绝: ${content.length} 字符 (限制: ${MAX_MESSAGE_LENGTH})`);
      return;
    }

    // 检查是否为其他命令（以 / 开头）
    if (content.startsWith('/')) {
      // 命令处理...
      await feishuClient.sendMessage(msg.chatId, {
        content: `未知命令: ${content}`,
        type: 'text',
      });
      return;
    }

    // 记录收到的消息
    logger.info(`收到飞书消息: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`);

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
        // Stage 1：路由 + Context 组装
        const context = await routeAndAssemble(
          msg.content,
          topicGraph,
          llmClient,
          memoryManager,
        );

        // 将用户消息追加到话题 history bucket
        context.topicHistory.addMessage({
          role: 'user',
          content: `[主人@飞书] ${msg.content}`,
        });

        // 注册话题专属工具（save_memory / update_topic_summary）到主 registry
        // 若已注册则先注销（下次不同话题时重新注册新 topicId 版本）
        const topicTools = createTopicTools(memoryManager, topicGraph, context.topicId);
        topicTools.forEach(t => {
          toolRegistry.unregister(t.definition.name);
          toolRegistry.register(t);
        });

        // 构建 system prompt（话题路由提供的 + 基础 prompt）
        const basePrompt = await buildSystemPrompt(storage);
        const systemPrompt = context.systemPrompt
          ? `${basePrompt}\n\n${context.systemPrompt}`
          : basePrompt;

        // Stage 2：Agent Loop（使用话题 history bucket）
        replyText = await runAgentLoop(
          llmClient,
          context.topicHistory,
          systemPrompt,
          toolRegistry,
        );

        // 保存话题 history bucket（持久化到磁盘）
        topicGraph.saveHistory(context.topicId, context.topicHistory);
        topicGraph.incrementTurnCount(context.topicId);

        // 写 pipeline 日志
        topicGraph.logPipeline({
          ts: Date.now(),
          msgPreview: content.slice(0, 50),
          topicId: context.topicId,
          isNewTopic: context.route.isNewTopic,
          confidence: context.route.confidence,
          historyStrategy: context.route.historyStrategy,
          contextTokens: context.topicHistory.stats().estimatedTokens,
        });

        // Stage 3 之后：异步触发 Background Pass（不阻塞回复）
        const executionSummary = buildExecutionSummary(context.topicHistory.getMessages());
        triggerBackgroundPass(
          { topicId: context.topicId, executionSummary },
          llmClient, topicGraph, memoryManager,
        );

      } catch (routingErr) {
        // 话题路由失败时降级到全局 historyManager（服务不中断）
        logger.warn('话题路由失败，降级为全局 history:', routingErr);
        historyManager.addMessage({
          role: 'user',
          content: `[主人@飞书] ${msg.content}`,
        });
        const systemPrompt = await buildSystemPrompt(storage);
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
async function buildSystemPrompt(storage: SQLiteStorage): Promise<string> {
  const builder = getPromptBuilder()

  // 注入记忆 - 使用新的记忆系统
  try {
    const memoryManager = getMemoryManager()
    await memoryManager.initialize()
    const memories = await memoryManager.getImportantMemories(15)
    if (memories.length > 0) {
      const memoryItems: MemoryItem[] = memories.map(m => ({
        key: m.id || '',
        value: m.content,
        importance: m.importance || 5,
        timestamp: m.createdAt || Date.now(),
      }))
      builder.setMemories(memoryItems)
    }
  } catch {
    // 记忆读取失败，使用基础提示词
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
  } catch {
    // 技能注册表读取失败，忽略
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
