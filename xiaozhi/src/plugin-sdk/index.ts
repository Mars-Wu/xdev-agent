// src/plugin-sdk/index.ts
// 插件 SDK 入口
// 参考 OpenClaw 的 plugin-sdk 设计

import {
  XiaozhiPlugin,
  PluginMetadata,
  PluginContext,
  PluginConfig,
  PluginMessage,
  PluginResponse,
  ChannelPlugin,
  SendMessageOptions,
} from './types';

// 事件总线
export { EventBus, eventBus, onEvent, emitEvent, emitEventAsync, EventTypes } from './event-bus';

// 插件管理器
export { PluginManager, createPluginManager } from './manager';
export type { PluginManagerConfig } from './manager';

