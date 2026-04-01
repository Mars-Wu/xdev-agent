// src/index.ts
// AI管家小智 - 入口
// 架构: Gateway + 插件系统 + 专家系统 + Claude CLI

import 'dotenv/config';
import { FeishuClient } from './feishu/client';
import { ClaudeNativeAgent } from './core/claude-native-agent';
import { HooksReceiver } from './api/hooks-receiver';
import { ExpertManager } from './expert/manager';
import { CronManager } from './cron/manager';
import { SQLiteStorage } from './storage/sqlite';
import { MemoryMonitor } from './monitor/memory-monitor';
import { createLogger } from './utils/logger';
import { PATHS, configManager } from './config';
import { GatewayServer, createGatewayServer } from './gateway';
import { PluginManager, createPluginManager, eventBus, EventTypes } from './plugin-sdk';
import * as path from 'path';
import * as os from 'os';

const logger = createLogger('main');

// Gateway 配置
const GATEWAY_PORT = parseInt(process.env.XIAOZHI_GATEWAY_PORT || '18789');
const GATEWAY_HOST = process.env.XIAOZHI_GATEWAY_HOST || '127.0.0.1';

/**
 * 验证必需的环境变量
 */
function validateConfig(): void {
  const requiredEnvVars = [
    { name: 'FEISHU_APP_ID', description: '飞书应用 ID' },
    { name: 'FEISHU_APP_SECRET', description: '飞书应用密钥' },
  ];

  const missing: string[] = [];

  for (const { name, description } of requiredEnvVars) {
    if (!process.env[name]) {
      missing.push(`${name} (${description})`);
    }
  }

  if (missing.length > 0) {
    logger.error('==========================================');
    logger.error('配置验证失败: 缺少必需的环境变量');
    logger.error('==========================================');
    for (const item of missing) {
      logger.error(`  - ${item}`);
    }
    logger.error('');
    logger.error('请在 .env 文件或环境变量中设置这些值');
    logger.error('==========================================');
    process.exit(1);
  }

  // 验证格式
  if (process.env.FEISHU_APP_ID && !process.env.FEISHU_APP_ID.startsWith('cli_')) {
    logger.warn('FEISHU_APP_ID 格式可能不正确（通常以 cli_ 开头）');
  }

  // 验证配置 Schema
  const validation = configManager.validate();
  if (!validation.valid) {
    logger.error('配置验证失败:');
    for (const error of validation.errors) {
      logger.error(`  - ${error}`);
    }
    process.exit(1);
  }

  logger.info('配置验证通过');
}

async function main() {
  // 配置验证
  validateConfig();

  logger.info('AI管家小智启动中...');
  logger.info('==========================================');
  logger.info('架构: Gateway + 插件系统 + 专家系统 + Claude CLI');
  logger.info('==========================================');

  const xiaozhiHome = PATHS.XIAOZHI_HOME;
  const hooksPort = parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081');

  logger.info(`xiaozhiHome: ${xiaozhiHome}`);
  logger.info(`os.homedir(): ${os.homedir()}`);

  // 配置参数 - 使用统一的配置管理器
  const xiaozhiConfig = configManager.getConfig();

  const config = {
    compactThreshold: parseInt(process.env.XIAOZHI_COMPACT_THRESHOLD || '') || 5 * 1024 * 1024,
    // 优先使用 API_TIMEOUT_MS (Claude settings), 然后是 XIAOZHI_TIMEOUT, 最后是配置文件
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

  // 2. Gateway 服务器
  const gateway = createGatewayServer({
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
  });

  // 3. 插件管理器
  const pluginManager = createPluginManager({
    pluginsDir: path.join(xiaozhiHome, 'plugins'),
    autoLoad: true,
  });
  await pluginManager.initialize();
  logger.info(`插件管理器已初始化`);

  // 4. 专家管理器（统一）
  const expertManager = new ExpertManager(
    storage,
    PATHS.EXPERTS_DIR,
    hooksPort,
    {
      maxConcurrent: parseInt(process.env.XIAOZHI_MAX_CONCURRENT || '') || 5,
      defaultTimeout: parseInt(process.env.XIAOZHI_DEFAULT_TIMEOUT || '') || 30 * 60 * 1000,
      preventRecursion: true,
      maxTaskLength: 10000,
      maxMessagesCount: 1000,
      sessionRetentionDays: 30,
    }
  );
  await expertManager.initialize();
  logger.info(`专家管理器已初始化`);

  // 5. Cron 定时任务管理器
  const cronManager = new CronManager(storage, {
    callbackUrl: `http://localhost:${hooksPort}/api/callbacks/complete`,
    maxTasks: 100,
    enablePersistence: true,
  });
  await cronManager.initialize();
  logger.info(`Cron 任务管理器已初始化`);

  // 6. HTTP 接收器
  const hooksReceiver = new HooksReceiver();
  hooksReceiver.listen(hooksPort);
  logger.info(`HTTP接收器已启动，端口 ${hooksPort}`);

  // 7. 内存监控
  const memoryMonitor = new MemoryMonitor(`http://localhost:${hooksPort}/api/callbacks/complete`);
  memoryMonitor.start();

  // 8. 飞书客户端
  const feishuClient = new FeishuClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    useWebSocket: true,
  });

  // 9. Claude Agent（小智）
  const agent = new ClaudeNativeAgent({
    feishuClient,
    model: process.env.XIAOZHI_MODEL,
    compactThreshold: config.compactThreshold,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelay,
    autoCompact: config.autoCompact,
  });

  // 10. 关联组件
  hooksReceiver.setAgent(agent);
  hooksReceiver.setExpertManager(expertManager);
  hooksReceiver.setCronManager(cronManager);
  logger.info('组件已关联');

  // 11. 消息处理
  feishuClient.setMessageHandler(async (msg) => {
    await agent.handleMessage(msg);
  });

  // 12. 设置 Gateway 依赖注入
  gateway.setExpertManager({
    getExperts: () => expertManager.getExperts(),
    getAllStatus: () => expertManager.getAllStatus(),
  });
  gateway.setPluginManager({
    getStats: () => pluginManager.getStats(),
    getPlugins: () => {
      // 返回简化的插件信息
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
      connected: true, // 飞书连接状态，启动后为 true
    }],
  });
  gateway.setChatHandler(async (message: string, clientId: string) => {
    return await agent.processGatewayMessage(message, clientId);
  });
  logger.info('Gateway 依赖已设置');

  // 13. 启动 Gateway
  await gateway.start();
  logger.info(`Gateway 已启动: ws://${GATEWAY_HOST}:${GATEWAY_PORT}`);

  // 14. 启动核心服务
  await agent.start();
  await feishuClient.start();

  // 注册事件监听
  eventBus.on(EventTypes.MESSAGE_RECEIVED, (data) => {
    gateway.broadcast({
      type: 'message:received',
      data,
      timestamp: Date.now(),
    });
  });

  eventBus.on(EventTypes.SESSION_STARTED, (data) => {
    gateway.broadcast({
      type: 'session:started',
      data,
      timestamp: Date.now(),
    });
  });

  // 显示启动信息
  const experts = expertManager.getExperts();
  const pluginStats = pluginManager.getStats();

  logger.info('==========================================');
  logger.info('可用专家:');
  for (const e of experts) {
    logger.info(`  - ${e.name}: ${e.description}`);
  }
  logger.info(`插件: ${pluginStats.total} 个已加载`);
  logger.info('==========================================');
  logger.info('可用命令:');
  logger.info('  /compact  - 压缩会话上下文');
  logger.info('  /stats    - 查看会话统计');
  logger.info('  /health   - 健康检查');
  logger.info('  /reset    - 重置会话');
  logger.info('==========================================');
  logger.info('API 端点:');
  logger.info(`  - GET  /api/experts          - 获取专家列表`);
  logger.info(`  - POST /api/experts/:name/call - 调用专家`);
  logger.info(`  - GET  /api/sessions/:id     - 获取会话状态`);
  logger.info(`  - POST /api/callbacks/complete - 专家完成回调`);
  logger.info(`  - GET  /api/cron/tasks       - 获取定时任务列表`);
  logger.info(`  - POST /api/cron/tasks       - 创建定时任务`);
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
    await agent.stop();

    // 2. 关闭 Gateway
    await gateway.stop();

    // 3. 关闭插件
    await pluginManager.shutdown();

    // 4. 关闭其他组件
    memoryMonitor.stop();
    cronManager.stop();
    hooksReceiver.close();
    storage.close();

    logger.info('AI管家小智已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
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
