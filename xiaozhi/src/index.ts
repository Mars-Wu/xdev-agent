// src/index.ts
// AI管家小智 - 入口
// 消息队列 + 统一专家系统 + Claude CLI 原生持久化

import 'dotenv/config';
import { FeishuClient } from './feishu/client';
import { ClaudeNativeAgent } from './core/claude-native-agent';
import { HooksReceiver } from './api/hooks-receiver';
import { ExpertManager } from './expert/manager';
import { SQLiteStorage } from './storage/sqlite';
import { MemoryMonitor } from './monitor/memory-monitor';
import { createLogger } from './utils/logger';
import { PATHS } from './config';
import * as path from 'path';
import * as os from 'os';

const logger = createLogger('main');

async function main() {
  logger.info('AI管家小智启动中...');
  logger.info('==========================================');
  logger.info('架构: 消息队列 + 统一专家系统 + Claude CLI');
  logger.info('==========================================');

  const xiaozhiHome = PATHS.XIAOZHI_HOME;
  const hooksPort = parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081');

  logger.info(`xiaozhiHome: ${xiaozhiHome}`);
  logger.info(`os.homedir(): ${os.homedir()}`);

  // 配置参数
  const config = {
    compactThreshold: parseInt(process.env.XIAOZHI_COMPACT_THRESHOLD || '') || 5 * 1024 * 1024,
    timeout: parseInt(process.env.XIAOZHI_TIMEOUT || '') || 120000,
    maxRetries: parseInt(process.env.XIAOZHI_MAX_RETRIES || '') || 3,
    retryDelay: parseInt(process.env.XIAOZHI_RETRY_DELAY || '') || 1000,
    autoCompact: process.env.XIAOZHI_AUTO_COMPACT === 'true',
  };

  logger.info('配置参数:');
  logger.info(`  - 压缩阈值: ${formatBytes(config.compactThreshold)}`);
  logger.info(`  - 请求超时: ${config.timeout / 1000}s`);
  logger.info(`  - 最大重试: ${config.maxRetries} 次`);

  // 1. 飞书客户端
  const feishuClient = new FeishuClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    useWebSocket: true,
  });

  // 2. 数据存储
  const storage = new SQLiteStorage(PATHS.DB_PATH);

  // 3. 专家管理器（统一）
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

  // 4. HTTP 接收器
  const hooksReceiver = new HooksReceiver();
  hooksReceiver.listen(hooksPort);
  logger.info(`HTTP接收器已启动，端口 ${hooksPort}`);

  // 5. 内存监控
  const memoryMonitor = new MemoryMonitor(`http://localhost:${hooksPort}/api/callbacks/complete`);
  memoryMonitor.start();

  // 6. Claude Agent（小智）
  const agent = new ClaudeNativeAgent({
    feishuClient,
    model: process.env.XIAOZHI_MODEL,
    compactThreshold: config.compactThreshold,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelay,
    autoCompact: config.autoCompact,
  });

  // 7. 关联组件
  hooksReceiver.setAgent(agent);
  hooksReceiver.setExpertManager(expertManager);
  logger.info('组件已关联');

  // 8. 消息处理
  feishuClient.setMessageHandler(async (msg) => {
    await agent.handleMessage(msg);
  });

  // 9. 启动
  await agent.start();
  await feishuClient.start();

  // 显示专家列表
  const experts = expertManager.getExperts();
  logger.info('==========================================');
  logger.info('可用专家:');
  for (const e of experts) {
    logger.info(`  - ${e.name}: ${e.description}`);
  }
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
  logger.info('==========================================');
  logger.info('AI管家小智已就绪');

  // 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info(`收到${signal}，正在关闭...`);
    memoryMonitor.stop();
    hooksReceiver.close();
    await agent.stop();
    await feishuClient.stop();
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
