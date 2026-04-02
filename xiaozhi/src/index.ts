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

  // 8. 消息历史管理器
  const historyManager = new MessageHistoryManager({
    maxMessages: 1000,
    maxTokens: 180_000,
    preserveRecent: 10,
    enableCompression: true,
    compressionThreshold: 0.9,
  });

  // 9. 消息处理
  feishuClient.setMessageHandler(async (msg) => {
    await handleMessage(msg, llmClient, feishuClient, historyManager, storage);
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
  gateway.setChatHandler(async (message: string, clientId: string) => {
    return await handleGatewayMessage(message, clientId, llmClient, historyManager);
  });
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

    // 添加用户消息到历史
    historyManager.addMessage({
      role: 'user',
      content: `[主人@飞书] ${msg.content}`,
    });

    // 构建系统提示词
    const systemPrompt = await buildSystemPrompt(storage);

    // 智能等待提示：只在响应较慢时才显示
    let thinkingShown = false;
    const thinkingTimer = setTimeout(async () => {
      thinkingShown = true;
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
      // 调用 LLM
      const response = await llmClient.chatSync({
        model: process.env.XIAOZHI_MODEL || 'glm-5',
        maxTokens: 16000,
        messages: historyManager.getMessages(),
        system: systemPrompt,
      });

      // 清除等待提示定时器
      clearTimeout(thinkingTimer);

      // 添加助手回复到历史
      historyManager.addMessage({
        role: 'assistant',
        content: response.content,
      });

      // 发送回复
      await feishuClient.sendMessage(msg.chatId, {
        content: response.content,
        type: 'text',
      });

      logger.info(`消息处理完成，使用 tokens: ${response.usage.inputTokens} + ${response.usage.outputTokens}`);
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
 * 处理 Gateway 消息
 */
async function handleGatewayMessage(
  message: string,
  clientId: string,
  llmClient: LLMClient,
  historyManager: MessageHistoryManager,
): Promise<string> {
  try {
    // 添加用户消息到历史
    historyManager.addMessage({
      role: 'user',
      content: `[CLI:${clientId.slice(0, 8)}] ${message}`,
    });

    // 调用 LLM（无状态模式，使用独立历史）
    const response = await llmClient.chatSync({
      model: process.env.XIAOZHI_MODEL || 'glm-5',
      maxTokens: 16000,
      messages: historyManager.getRecentMessages(10),
      system: '你是小智，一个智能助手。简洁友好地回答用户问题。',
    });

    return response.content;
  } catch (error) {
    logger.error('处理 Gateway 消息失败:', error);
    return `处理失败: ${error instanceof Error ? error.message : String(error)}`;
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

  return builder.build({ includeMemory: true })
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
