// src/monitor/memory-monitor.ts
// 内存监控定时任务

import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger';

const execAsync = promisify(exec);
const logger = createLogger('memory-monitor');

export class MemoryMonitor {
  private timer?: NodeJS.Timeout;
  private callbackUrl: string;
  private interval: number = 60000;                    // 检查间隔：1分钟
  private threshold: number = 75;                      // 告警阈值：75%
  private minAlertInterval: number = 5 * 60 * 1000;   // 告警间隔：5分钟
  private lastAlertTime: number = 0;

  constructor(callbackUrl: string) {
    this.callbackUrl = callbackUrl;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), this.interval);
    process.once('exit', () => this.stop());
    logger.info(`内存监控已启动 (阈值: ${this.threshold}%, 告警间隔: 5分钟)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    logger.info('内存监控已停止');
  }

  private async check(): Promise<void> {
    try {
      // 获取内存使用率
      const { stdout: memStdout } = await execAsync(
        "free | grep Mem | awk '{printf \"%.1f\", $3/$2 * 100}'"
      );
      const usedPercent = parseFloat(memStdout.trim());

      if (isNaN(usedPercent) || usedPercent < this.threshold) {
        return;
      }

      // 检查是否在最小告警间隔内
      const now = Date.now();
      if (now - this.lastAlertTime < this.minAlertInterval) {
        logger.debug(`跳过告警 (距上次告警 ${Math.round((now - this.lastAlertTime) / 1000)}s)`);
        return;
      }
      this.lastAlertTime = now;

      // 获取占用内存最多的进程
      let topProcesses = '';
      try {
        const { stdout: psStdout } = await execAsync(
          'ps aux --sort=-%mem | head -6 | tail -5'
        );
        topProcesses = psStdout.trim();
      } catch (error) {
        logger.debug('获取进程信息失败:', error);
        topProcesses = '无法获取进程信息';
      }

      const message = JSON.stringify({
        type: 'memory_alert',
        usedPercent,
        topProcesses,
        timestamp: new Date().toISOString(),
      });

      logger.warn(`内存告警: ${usedPercent}%`);

      // 通过专家回调 API 发送给小智
      const payload = JSON.stringify({
        expert: 'system-monitor',
        success: true,
        result: message,
      });

      await execAsync(
        `curl -s -X POST ${this.callbackUrl} ` +
        `-H "Content-Type: application/json" ` +
        `-d '${payload}'`
      );
    } catch (error) {
      logger.error('内存检查失败:', error);
    }
  }
}
