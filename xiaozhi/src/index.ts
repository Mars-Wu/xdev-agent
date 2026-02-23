// src/index-native.ts
// AI管家小智 - 原生版入口
// 最大化利用 Claude CLI 的原生功能
//
// 架构特点:
// 1. 使用 --session-id 让 Claude CLI 自己管理会话持久化
// 2. 会话存储在 ~/.claude/projects/<hash>/<session-id>.jsonl
// 3. 支持 /compact、/stats、/health、/reset 命令
// 4. 自动检测会话健康状态并在需要时提示用户

import 'dotenv/config';
import { FeishuClient } from './feishu/client';
import { ClaudeNativeAgent } from './core/claude-native-agent';
import { HooksReceiver } from './worker/hooks-receiver';
import { WorkerManager } from './worker/manager';
import { SessionManager } from './session/manager';
import { SQLiteStorage } from './storage/sqlite';
import { createLogger } from './utils/logger';
import * as path from 'path';
import * as os from 'os';

const logger = createLogger('main');

async function main() {
  logger.info('AI管家小智启动中 (原生架构)...');
  logger.info('==========================================');
  logger.info('架构: spawn + --session-id 原生持久化');
  logger.info('==========================================');

  const xiaozhiHome = process.env.XIAOZHI_HOME || path.join(os.homedir(), '.xiaozhi');
  const hooksPort = parseInt(process.env.XIAOZHI_HOOKS_PORT || '8081');

  // 配置参数（可通过环境变量覆盖）
  const config = {
    // 压缩阈值：会话文件超过此大小时提示用户压缩
    compactThreshold: parseInt(process.env.XIAOZHI_COMPACT_THRESHOLD || '') || 5 * 1024 * 1024, // 5MB

    // 请求超时：单次 Claude 调用的最长等待时间
    timeout: parseInt(process.env.XIAOZHI_TIMEOUT || '') || 120000, // 2分钟

    // 重试次数：失败后自动重试的最大次数
    maxRetries: parseInt(process.env.XIAOZHI_MAX_RETRIES || '') || 3,

    // 重试延迟：指数退避的基数（ms）
    retryDelay: parseInt(process.env.XIAOZHI_RETRY_DELAY || '') || 1000, // 1秒

    // 自动压缩：是否在超过阈值时自动压缩（默认 false，提示用户手动处理）
    autoCompact: process.env.XIAOZHI_AUTO_COMPACT === 'true',
  };

  logger.info('配置参数:');
  logger.info(`  - 压缩阈值: ${formatBytes(config.compactThreshold)}`);
  logger.info(`  - 请求超时: ${config.timeout / 1000}s`);
  logger.info(`  - 最大重试: ${config.maxRetries} 次`);
  logger.info(`  - 自动压缩: ${config.autoCompact ? '开启' : '关闭'}`);

  // 1. 飞书客户端
  const feishuClient = new FeishuClient({
    appId: process.env.FEISHU_APP_ID!,
    appSecret: process.env.FEISHU_APP_SECRET!,
    useWebSocket: true,
  });

  // 2. Worker 相关组件（处理复杂任务）
  const storage = new SQLiteStorage(path.join(xiaozhiHome, 'xiaozhi.db'));
  const sessionManager = new SessionManager(storage, { maxContextMessages: 50, compressThreshold: 40 });
  const workerManager = new WorkerManager(storage, {
    baseDir: path.join(xiaozhiHome, 'workers'),
    scriptsDir: path.join(xiaozhiHome, 'scripts'),
    xiaozhiHost: 'localhost',
    xiaozhiPort: hooksPort,
  });

  // 3. Hooks 接收器
  const hooksReceiver = new HooksReceiver(workerManager, feishuClient, sessionManager);
  hooksReceiver.listen(hooksPort);
  logger.info(`Hooks接收器已启动，端口 ${hooksPort}`);

  // 4. Claude Agent（核心！）
  const agent = new ClaudeNativeAgent({
    feishuClient,
    model: process.env.XIAOZHI_MODEL,
    // 配置
    compactThreshold: config.compactThreshold,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelay,
    autoCompact: config.autoCompact,
  });

  // 5. 消息处理
  feishuClient.setMessageHandler(async (msg) => {
    await agent.handleMessage(msg);
  });

  // 6. 启动
  await agent.start();
  await feishuClient.start();

  logger.info('飞书连接已建立，小智开始工作');
  logger.info('==========================================');
  logger.info('可用命令:');
  logger.info('  /compact  - 压缩会话上下文');
  logger.info('  /stats    - 查看会话统计');
  logger.info('  /health   - 健康检查');
  logger.info('  /reset    - 重置会话');
  logger.info('==========================================');
  logger.info('AI管家小智已就绪');

  // 优雅关闭
  const shutdown = async (signal: string) => {
    logger.info(`收到${signal}，正在关闭...`);
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

/**
 * 格式化字节数
 */
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
