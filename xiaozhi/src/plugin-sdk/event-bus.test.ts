// src/plugin-sdk/event-bus.test.ts
// 事件总线单元测试

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, EventTypes, onEvent, emitEvent } from './event-bus';

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus({ logEvents: false });
  });

  describe('on', () => {
    it('应该注册事件监听器', () => {
      const handler = vi.fn();
      eventBus.on('test', handler);

      eventBus.emit('test', { data: 'hello' });

      expect(handler).toHaveBeenCalledWith({ data: 'hello' });
    });

    it('应该返回取消订阅函数', () => {
      const handler = vi.fn();
      const unsubscribe = eventBus.on('test', handler);

      unsubscribe();
      eventBus.emit('test', { data: 'hello' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('应该支持多个监听器', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('test', handler1);
      eventBus.on('test', handler2);

      eventBus.emit('test', { data: 'hello' });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('应该按优先级调用监听器', () => {
      const order: number[] = [];

      eventBus.on('test', () => { order.push(1); }, { priority: 1 });
      eventBus.on('test', () => { order.push(3); }, { priority: 3 });
      eventBus.on('test', () => { order.push(2); }, { priority: 2 });

      eventBus.emit('test');

      expect(order).toEqual([3, 2, 1]);
    });
  });

  describe('once', () => {
    it('应该只触发一次', () => {
      const handler = vi.fn();
      eventBus.once('test', handler);

      eventBus.emit('test', { data: 1 });
      eventBus.emit('test', { data: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ data: 1 });
    });
  });

  describe('emit', () => {
    it('应该触发所有监听器', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('test', handler1);
      eventBus.on('test', handler2);

      eventBus.emit('test', { data: 'hello' });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('没有监听器时应该正常工作', () => {
      expect(() => eventBus.emit('nonexistent', {})).not.toThrow();
    });

    it('处理函数错误不应该影响其他处理函数', () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Test error');
      });
      const normalHandler = vi.fn();

      eventBus.on('test', errorHandler);
      eventBus.on('test', normalHandler);

      eventBus.emit('test', {});

      expect(errorHandler).toHaveBeenCalled();
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  describe('emitAsync', () => {
    it('应该等待异步处理函数', async () => {
      const order: number[] = [];

      eventBus.on('test', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(1);
      });

      eventBus.on('test', async () => {
        order.push(2);
      });

      await eventBus.emitAsync('test', {});

      expect(order).toContain(1);
      expect(order).toContain(2);
    });
  });

  describe('hasListeners', () => {
    it('有监听器时应该返回 true', () => {
      eventBus.on('test', () => {});
      expect(eventBus.hasListeners('test')).toBe(true);
    });

    it('没有监听器时应该返回 false', () => {
      expect(eventBus.hasListeners('test')).toBe(false);
    });
  });

  describe('listenerCount', () => {
    it('应该返回正确的监听器数量', () => {
      eventBus.on('test', () => {});
      eventBus.on('test', () => {});
      eventBus.on('other', () => {});

      expect(eventBus.listenerCount('test')).toBe(2);
      expect(eventBus.listenerCount('other')).toBe(1);
      expect(eventBus.listenerCount('nonexistent')).toBe(0);
    });
  });

  describe('clear', () => {
    it('应该移除所有监听器', () => {
      eventBus.on('test1', () => {});
      eventBus.on('test2', () => {});

      eventBus.clear();

      expect(eventBus.hasListeners('test1')).toBe(false);
      expect(eventBus.hasListeners('test2')).toBe(false);
    });
  });

  describe('getStats', () => {
    it('应该返回正确的统计信息', () => {
      eventBus.on('test1', () => {});
      eventBus.on('test1', () => {});
      eventBus.on('test2', () => {});

      const stats = eventBus.getStats();

      expect(stats.eventTypes).toBe(2);
      expect(stats.totalSubscriptions).toBe(3);
    });
  });
});

describe('EventTypes', () => {
  it('应该定义内置事件类型', () => {
    expect(EventTypes.MESSAGE_RECEIVED).toBe('message:received');
    expect(EventTypes.MESSAGE_SENT).toBe('message:sent');
    expect(EventTypes.PLUGIN_LOADED).toBe('plugin:loaded');
    expect(EventTypes.SESSION_STARTED).toBe('session:started');
    expect(EventTypes.SYSTEM_START).toBe('system:start');
    expect(EventTypes.CONFIG_CHANGED).toBe('config:changed');
  });
});

describe('快捷函数', () => {
  it('onEvent 应该注册监听器', () => {
    const handler = vi.fn();
    const unsubscribe = onEvent('test', handler);

    emitEvent('test', { data: 'hello' });

    expect(handler).toHaveBeenCalled();
    unsubscribe();
  });

  it('emitEvent 应该触发事件', () => {
    const handler = vi.fn();
    onEvent('test', handler);

    emitEvent('test', { data: 'hello' });

    expect(handler).toHaveBeenCalledWith({ data: 'hello' });
  });
});
