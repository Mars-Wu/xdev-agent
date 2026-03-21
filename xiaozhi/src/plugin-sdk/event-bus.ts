// src/plugin-sdk/event-bus.ts
// 事件总线 - 插件间通信的核心组件
// 实现发布/订阅模式，支持异步事件处理

import { createLogger } from '../utils/logger';

const logger = createLogger('event-bus');

/**
 * 事件处理器
 */
type EventHandler = (data: unknown) => void | Promise<void>;

/**
 * 事件订阅信息
 */
interface EventSubscription {
  id: string;
  handler: EventHandler;
  once: boolean;
  priority: number;
}

/**
 * 事件总线配置
 */
export interface EventBusConfig {
  // 是否记录事件日志
  logEvents?: boolean;
  // 最大监听器数量
  maxListeners?: number;
  // 异步执行超时
  asyncTimeout?: number;
}

/**
 * 内置事件类型
 */
export const EventTypes = {
  // 消息相关
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_SENT: 'message:sent',
  MESSAGE_ERROR: 'message:error',

  // 插件相关
  PLUGIN_LOADED: 'plugin:loaded',
  PLUGIN_UNLOADED: 'plugin:unloaded',
  PLUGIN_ERROR: 'plugin:error',

  // 会话相关
  SESSION_STARTED: 'session:started',
  SESSION_ENDED: 'session:ended',
  SESSION_ERROR: 'session:error',

  // 系统相关
  SYSTEM_START: 'system:start',
  SYSTEM_SHUTDOWN: 'system:shutdown',
  SYSTEM_ERROR: 'system:error',

  // 配置相关
  CONFIG_CHANGED: 'config:changed',
} as const;

/**
 * 事件总线
 *
 * 提供插件间解耦通信的核心机制。
 */
export class EventBus {
  private subscriptions: Map<string, EventSubscription[]> = new Map();
  private config: Required<EventBusConfig>;
  private subscriptionCounter: number = 0;

  constructor(config: EventBusConfig = {}) {
    this.config = {
      logEvents: config.logEvents ?? false,
      maxListeners: config.maxListeners ?? 100,
      asyncTimeout: config.asyncTimeout ?? 30000,
    };
  }

  /**
   * 订阅事件
   *
   * @param event 事件名称
   * @param handler 处理函数
   * @param options 订阅选项
   * @returns 取消订阅函数
   */
  on(
    event: string,
    handler: EventHandler,
    options?: { once?: boolean; priority?: number }
  ): () => void {
    const subscription: EventSubscription = {
      id: `${event}-${++this.subscriptionCounter}`,
      handler,
      once: options?.once ?? false,
      priority: options?.priority ?? 0,
    };

    if (!this.subscriptions.has(event)) {
      this.subscriptions.set(event, []);
    }

    const subs = this.subscriptions.get(event)!;

    // 检查监听器数量限制
    if (subs.length >= this.config.maxListeners) {
      logger.warn(`事件 "${event}" 监听器数量已达上限 ${this.config.maxListeners}`);
    }

    // 按优先级插入
    const insertIndex = subs.findIndex(s => s.priority < subscription.priority);
    if (insertIndex === -1) {
      subs.push(subscription);
    } else {
      subs.splice(insertIndex, 0, subscription);
    }

    if (this.config.logEvents) {
      logger.debug(`订阅事件: ${event} (id: ${subscription.id})`);
    }

    // 返回取消订阅函数
    return () => this.off(event, subscription.id);
  }

  /**
   * 订阅一次事件
   */
  once(event: string, handler: EventHandler, priority?: number): () => void {
    return this.on(event, handler, { once: true, priority });
  }

  /**
   * 取消订阅
   */
  private off(event: string, subscriptionId: string): void {
    const subs = this.subscriptions.get(event);
    if (!subs) return;

    const index = subs.findIndex(s => s.id === subscriptionId);
    if (index !== -1) {
      subs.splice(index, 1);
      if (this.config.logEvents) {
        logger.debug(`取消订阅: ${event} (id: ${subscriptionId})`);
      }
    }
  }

  /**
   * 发布事件（同步）
   */
  emit(event: string, data?: unknown): void {
    if (this.config.logEvents) {
      logger.debug(`发布事件: ${event}`, data);
    }

    const subs = this.subscriptions.get(event);
    if (!subs || subs.length === 0) return;

    // 收集需要移除的订阅
    const toRemove: string[] = [];

    for (const sub of subs) {
      try {
        sub.handler(data);
        if (sub.once) {
          toRemove.push(sub.id);
        }
      } catch (error) {
        logger.error(`事件处理器错误 [${event}]:`, error);
      }
    }

    // 移除一次性订阅
    for (const id of toRemove) {
      this.off(event, id);
    }
  }

  /**
   * 发布事件（异步）
   *
   * 等待所有处理器完成，支持超时
   */
  async emitAsync(event: string, data?: unknown): Promise<void> {
    if (this.config.logEvents) {
      logger.debug(`发布异步事件: ${event}`, data);
    }

    const subs = this.subscriptions.get(event);
    if (!subs || subs.length === 0) return;

    const toRemove: string[] = [];
    const promises: Promise<void>[] = [];

    for (const sub of subs) {
      const result = sub.handler(data);

      if (result instanceof Promise) {
        promises.push(
          Promise.race([
            result,
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error(`处理器超时: ${sub.id}`)),
                this.config.asyncTimeout
              )
            ),
          ]).catch(error => {
            logger.error(`异步事件处理器错误 [${event}]:`, error);
          })
        );
      }

      if (sub.once) {
        toRemove.push(sub.id);
      }
    }

    await Promise.all(promises);

    // 移除一次性订阅
    for (const id of toRemove) {
      this.off(event, id);
    }
  }

  /**
   * 检查事件是否有订阅者
   */
  hasListeners(event: string): boolean {
    const subs = this.subscriptions.get(event);
    return subs !== undefined && subs.length > 0;
  }

  /**
   * 获取事件的订阅者数量
   */
  listenerCount(event: string): number {
    return this.subscriptions.get(event)?.length ?? 0;
  }

  /**
   * 移除所有订阅
   */
  clear(): void {
    this.subscriptions.clear();
    logger.info('所有事件订阅已清除');
  }

  /**
   * 获取事件统计信息
   */
  getStats(): { eventTypes: number; totalSubscriptions: number } {
    let total = 0;
    for (const subs of this.subscriptions.values()) {
      total += subs.length;
    }
    return {
      eventTypes: this.subscriptions.size,
      totalSubscriptions: total,
    };
  }
}

// 全局事件总线实例
export const eventBus = new EventBus({ logEvents: process.env.NODE_ENV === 'development' });

/**
 * 快捷订阅函数
 */
export function onEvent(event: string, handler: EventHandler): () => void {
  return eventBus.on(event, handler);
}

/**
 * 快捷发布函数
 */
export function emitEvent(event: string, data?: unknown): void {
  eventBus.emit(event, data);
}

/**
 * 快捷异步发布函数
 */
export function emitEventAsync(event: string, data?: unknown): Promise<void> {
  return eventBus.emitAsync(event, data);
}
