// src/index.ts
// AI管家小智 - 入口文件

import 'dotenv/config';
import * as path from 'path';
import { XiaoZhiService } from './core/xiaozhi';
import { HooksReceiver } from './worker/hooks-receiver';
import { MessageHandler } from './core/message-handler';
import { createLogger, setLogLevel } from './utils/logger';

const logger = createLogger('main');

async function main() {
  logger.info('AI管家小智启动中...');

  // 检查必要的环境变量
  const requiredEnvVars = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    logger.error(`缺少必要的环境变量: ${missing.join(', ')}`);
    logger.error('请设置以下环境变量或创建 .env 文件:');
    logger.error('  FEISHU_APP_ID=your_app_id');
    logger.error('  FEISHU_APP_SECRET=your_app_secret');
    process.exit(1);
  }

  // 设置日志级别
  setLogLevel((process.env.LOG_LEVEL as any) || 'info');

  // 获取配置
  const xiaozhiHome = process.env.XIAOZHI_HOME || '/var/lib/xiaozhi';
  const hooksPort = parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081');

  // 1. 初始化小智服务
  const xiaozhi = new XiaoZhiService({
    model: process.env.XIAOZHI_MODEL || 'claude-sonnet-4-5-20250929',
    storage: {
      type: 'sqlite',
      path: process.env.XIAOZHI_DB || path.join(xiaozhiHome, 'data', 'xiaozhi.db'),
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID!,
      appSecret: process.env.FEISHU_APP_SECRET!,
      useWebSocket: process.env.FEISHU_USE_WEBSOCKET !== 'false',
    },
    worker: {
      baseDir: xiaozhiHome,
      scriptsDir: path.join(xiaozhiHome, 'scripts'),
      hooksPort,
    },
  });

  // 2. 初始化消息处理器
  const messageHandler = new MessageHandler(
    xiaozhi.feishuClientPublic,
    xiaozhi.sessionManagerPublic,
    xiaozhi.workerManagerPublic
  );

  // 3. 启动Hooks接收器（接收Worker通知）
  const hooksReceiver = new HooksReceiver(
    xiaozhi.workerManagerPublic,
    xiaozhi.feishuClientPublic,
    xiaozhi.sessionManagerPublic
  );
  hooksReceiver.listen(hooksPort);
  logger.info(`Hooks接收器已启动，监听端口 ${hooksPort}`);

  // 4. 启动飞书连接（开始接收用户消息）
  await xiaozhi.start();
  logger.info('飞书连接已建立，小智开始工作');

  // 5. 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info(`收到${signal}信号，正在关闭...`);
    hooksReceiver.close();
    await xiaozhi.stop();
    logger.info('AI管家小智已停止');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('AI管家小智已就绪 ✅');
}

main().catch((error) => {
  logger.error('启动失败:', error);
  process.exit(1);
});
