// src/index-simple.ts
// AI管家小智 - 简化版入口
// 架构：飞书 ←→ FeishuClaudeAgent ←→ Claude CLI (tmux)
// 这就是"把终端换成飞书"的直接实现

import 'dotenv/config';
import { FeishuClient } from './feishu/client';
import { FeishuClaudeAgent } from './core/feishu-claude-agent';
import { HooksReceiver } from './worker/hooks-receiver';
import { WorkerManager } from './worker/manager';
import { SessionManager } from './session/manager';
import { SQLiteStorage } from './storage/sqlite';
import { createLogger } from './utils/logger';
import * as path from 'path';

const logger = createLogger('main');

async function main() {
  logger.info('AI管家小智启动中 (简化架构)...');

  // 基础配置
  const xiaozhiHome = process.env.XIAOZHI_HOME || path.join(process.env.HOME!, 'data');
  const hooksPort = parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081');

  // 1. 初始化存储
  const storage = new SQLiteStorage(
    process.env.XIAOZHI_DB || path.join(xiaozhiHome, 'xiaozhi.db')
  );

  // 2. 初始化飞书客户端
  const feishuClient = new FeishuClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    useWebSocket: true,
  });

  // 3. 初始化会话管理（仅用于Worker管理）
  const sessionManager = new SessionManager(storage, {
    maxContextMessages: 50,
    compressThreshold: 40,
  });

  // 4. 初始化Worker管理器（处理复杂任务）
  const workerManager = new WorkerManager(storage, {
    baseDir: xiaozhiHome,
    scriptsDir: path.join(xiaozhiHome, 'scripts'),
    xiaozhiHost: 'localhost',
    xiaozhiPort: hooksPort,
  });

  // 5. 初始化 Hooks 接收器（接收Worker通知）
  const hooksReceiver = new HooksReceiver(workerManager, feishuClient, sessionManager);
  hooksReceiver.listen(hooksPort);
  logger.info(`Hooks接收器已启动，端口 ${hooksPort}`);

  // 6. 初始化 Claude Agent（核心！）
  const agent = new FeishuClaudeAgent({
    feishuClient,
    sessionName: 'xiaozhi-agent',
  });

  // 7. 设置飞书消息处理器 - 直接转发给Agent
  feishuClient.setMessageHandler(async (msg) => {
    await agent.handleMessage(msg);
  });

  // 8. 启动Agent和飞书连接
  await agent.start();
  await feishuClient.start();

  logger.info('飞书连接已建立，小智开始工作');
  logger.info('AI管家小智已就绪 ✅');

  // 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info(`收到${signal}信号，正在关闭...`);
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

main().catch((error) => {
  logger.error('启动失败:', error);
  process.exit(1);
});
