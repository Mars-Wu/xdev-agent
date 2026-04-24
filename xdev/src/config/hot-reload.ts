// src/config/hot-reload.ts
// 配置热重载 - 监听配置文件变化并自动重载
// 参考 OpenClaw 的配置重载机制

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('config-hot-reload');

/**
 * 配置变更监听器
 */
export type ConfigChangeListener = (newConfig: unknown, oldConfig: unknown) => void;

/**
 * 热重载配置
 */
export interface HotReloadOptions {
  // 配置文件路径
  configPath: string;
  // 防抖延迟（毫秒）
  debounceMs?: number;
  // 是否启用
  enabled?: boolean;
  // 解析函数
  parse?: (content: string) => unknown;
}

/**
 * 配置热重载管理器
 *
 * 监听配置文件变化，自动重载配置并通知订阅者。
 * 使用 fs.watch API 实现文件监听。
 */
export class ConfigHotReloader {
  private configPath: string;
  private debounceMs: number;
  private enabled: boolean;
  private parse: (content: string) => unknown;

  private watcher: fs.FSWatcher | null = null;
  private listeners: ConfigChangeListener[] = [];
  private currentConfig: unknown = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(options: HotReloadOptions) {
    this.configPath = options.configPath;
    this.debounceMs = options.debounceMs || 1000;
    this.enabled = options.enabled ?? true;
    this.parse = options.parse || JSON.parse;
  }

  /**
   * 启动热重载
   */
  start(initialConfig: unknown): void {
    if (!this.enabled) {
      logger.debug('热重载已禁用');
      return;
    }

    this.currentConfig = initialConfig;

    // 检查文件是否存在
    if (!fs.existsSync(this.configPath)) {
      logger.warn(`配置文件不存在: ${this.configPath}`);
      return;
    }

    try {
      this.watcher = fs.watch(
        this.configPath,
        { persistent: false },
        (eventType) => {
          if (eventType === 'change') {
            this.handleFileChange();
          }
        }
      );

      this.watcher.on('error', (error) => {
        logger.error(`配置文件监听错误: ${error.message}`);
      });

      logger.info(`配置热重载已启动: ${this.configPath}`);
    } catch (error) {
      logger.error(`启动配置监听失败: ${error}`);
    }
  }

  /**
   * 停止热重载
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('配置热重载已停止');
    }
  }

  /**
   * 添加配置变更监听器
   */
  addListener(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);

    // 返回取消订阅函数
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * 处理文件变更
   */
  private handleFileChange(): void {
    // 防抖处理
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.reloadConfig();
    }, this.debounceMs);
  }

  /**
   * 重新加载配置
   */
  private reloadConfig(): void {
    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const newConfig = this.parse(content);
      const oldConfig = this.currentConfig;

      // 检查配置是否真的变化了
      if (this.configEquals(oldConfig, newConfig)) {
        logger.debug('配置未实际变化，跳过重载');
        return;
      }

      this.currentConfig = newConfig;
      logger.info('检测到配置变更，正在重载...');

      // 通知所有监听器
      for (const listener of this.listeners) {
        try {
          listener(newConfig, oldConfig);
        } catch (error) {
          logger.error(`配置监听器执行错误: ${error}`);
        }
      }

      logger.info('配置重载完成');
    } catch (error) {
      logger.error(`重载配置失败: ${error}`);
    }
  }

  /**
   * 简单比较两个配置是否相等
   */
  private configEquals(a: unknown, b: unknown): boolean {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * 手动触发重载
   */
  forceReload(): void {
    this.reloadConfig();
  }

  /**
   * 获取当前配置
   */
  getCurrentConfig(): unknown {
    return this.currentConfig;
  }

  /**
   * 检查是否正在运行
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }
}

/**
 * 创建配置热重载器
 */
export function createConfigHotReloader(options: HotReloadOptions): ConfigHotReloader {
  return new ConfigHotReloader(options);
}
