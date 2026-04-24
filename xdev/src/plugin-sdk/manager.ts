// src/plugin-sdk/manager.ts
// 插件管理器 - 加载、管理、协调插件

import * as path from 'path';
import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger';
import { EventBus, eventBus, EventTypes } from './event-bus';
import {
  XdevPlugin,
  PluginMetadata,
  PluginStatus,
  PluginContext,
  PluginConfig,
  PluginStorage,
  PluginMessage,
  PluginResponse,
  PluginLoadResult,
  PluginManager as IPluginManager,
} from './types';

const logger = createLogger('plugin-manager');

/**
 * 插件管理器配置
 */
export interface PluginManagerConfig {
  // 插件目录
  pluginsDir: string;
  // 是否自动加载
  autoLoad?: boolean;
  // 内置插件（直接注册）
  builtinPlugins?: XdevPlugin[];
}

/**
 * 已加载的插件信息
 */
interface LoadedPlugin {
  plugin: XdevPlugin;
  status: PluginStatus;
  config: PluginConfig;
  context: PluginContext;
  loadTime: Date;
  error?: string;
}

/**
 * 插件管理器
 *
 * 负责插件的加载、卸载、启用、禁用和生命周期管理。
 */
export class PluginManager implements IPluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginsDir: string;
  private autoLoad: boolean;
  private storage: Map<string, Map<string, unknown>> = new Map();

  constructor(config: PluginManagerConfig) {
    this.pluginsDir = config.pluginsDir;
    this.autoLoad = config.autoLoad ?? true;

    // 注册内置插件
    if (config.builtinPlugins) {
      for (const plugin of config.builtinPlugins) {
        this.register(plugin);
      }
    }
  }

  /**
   * 初始化并加载所有插件
   */
  async initialize(): Promise<void> {
    if (!this.autoLoad) {
      logger.info('自动加载已禁用');
      return;
    }

    try {
      // 确保插件目录存在
      await fs.mkdir(this.pluginsDir, { recursive: true });

      // 扫描并加载插件
      const entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginPath = path.join(this.pluginsDir, entry.name);
          const result = await this.load(pluginPath);
          if (result.success) {
            logger.info(`已加载插件: ${result.plugin?.metadata.name}`);
          } else {
            logger.warn(`加载插件失败 [${entry.name}]: ${result.error}`);
          }
        }
      }

      logger.info(`插件初始化完成，已加载 ${this.plugins.size} 个插件`);
    } catch (error) {
      logger.error('插件初始化失败:', error);
    }
  }

  /**
   * 注册插件（内置插件使用）
   */
  register(plugin: XdevPlugin): boolean {
    const metadata = plugin.metadata;

    if (this.plugins.has(metadata.id)) {
      logger.warn(`插件已存在: ${metadata.id}`);
      return false;
    }

    const context = this.createContext(plugin);
    const loaded: LoadedPlugin = {
      plugin,
      status: 'loaded',
      config: { enabled: true },
      context,
      loadTime: new Date(),
    };

    this.plugins.set(metadata.id, loaded);
    logger.info(`已注册插件: ${metadata.name} v${metadata.version}`);

    return true;
  }

  /**
   * 加载插件
   */
  async load(pluginPath: string): Promise<PluginLoadResult> {
    try {
      // 读取插件元数据
      const manifestPath = path.join(pluginPath, 'plugin.json');
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest: PluginMetadata = JSON.parse(manifestContent);

      // 检查依赖
      if (manifest.dependencies) {
        for (const dep of manifest.dependencies) {
          if (!this.plugins.has(dep)) {
            return {
              success: false,
              error: `缺少依赖插件: ${dep}`,
            };
          }
        }
      }

      // 动态加载插件
      const mainPath = path.join(pluginPath, manifest.main);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pluginModule = require(mainPath);
      const plugin: XdevPlugin = pluginModule.default || pluginModule;

      // 验证插件接口
      if (!plugin.metadata || !plugin.metadata.id) {
        return {
          success: false,
          error: '无效的插件：缺少 metadata',
        };
      }

      // 创建插件上下文
      const context = this.createContext(plugin);

      // 调用插件的 setup 方法
      if (plugin.setup) {
        await plugin.setup(context);
      }

      // 注册插件
      const loaded: LoadedPlugin = {
        plugin,
        status: 'loaded',
        config: { enabled: true },
        context,
        loadTime: new Date(),
      };

      this.plugins.set(plugin.metadata.id, loaded);

      // 发送事件
      eventBus.emit(EventTypes.PLUGIN_LOADED, { pluginId: plugin.metadata.id });

      return { success: true, plugin };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`加载插件失败: ${pluginPath}`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * 卸载插件
   */
  async unload(pluginId: string): Promise<boolean> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      return false;
    }

    try {
      // 调用插件的 teardown 方法
      if (loaded.plugin.teardown) {
        await loaded.plugin.teardown();
      }

      this.plugins.delete(pluginId);

      // 发送事件
      eventBus.emit(EventTypes.PLUGIN_UNLOADED, { pluginId });

      logger.info(`已卸载插件: ${pluginId}`);
      return true;
    } catch (error) {
      logger.error(`卸载插件失败: ${pluginId}`, error);
      return false;
    }
  }

  /**
   * 获取插件
   */
  get(pluginId: string): XdevPlugin | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  /**
   * 获取所有插件
   */
  getAll(): XdevPlugin[] {
    return Array.from(this.plugins.values()).map(l => l.plugin);
  }

  /**
   * 获取插件状态
   */
  getStatus(pluginId: string): PluginStatus {
    return this.plugins.get(pluginId)?.status || 'unloaded';
  }

  /**
   * 启用/禁用插件
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
    const loaded = this.plugins.get(pluginId);
    if (!loaded) {
      return false;
    }

    loaded.config.enabled = enabled;
    loaded.status = enabled ? 'loaded' : 'disabled';

    logger.info(`插件 ${pluginId} 已${enabled ? '启用' : '禁用'}`);
    return true;
  }

  /**
   * 处理消息（按插件优先级）
   */
  async handleMessage(message: PluginMessage): Promise<PluginResponse | null> {
    // 按类型过滤插件
    const channelPlugins = Array.from(this.plugins.values())
      .filter(l => l.config.enabled && l.plugin.handleMessage)
      .sort((a, b) => {
        // 内置通道优先
        const aPriority = a.plugin.metadata.type === 'channel' ? 0 : 1;
        const bPriority = b.plugin.metadata.type === 'channel' ? 0 : 1;
        return aPriority - bPriority;
      });

    for (const loaded of channelPlugins) {
      try {
        const response = await loaded.plugin.handleMessage!(message);
        if (response && !response.continuePropagation) {
          return response;
        }
      } catch (error) {
        logger.error(`插件处理消息错误 [${loaded.plugin.metadata.id}]:`, error);
        loaded.status = 'error';
        loaded.error = error instanceof Error ? error.message : String(error);
      }
    }

    return null;
  }

  /**
   * 创建插件上下文
   */
  private createContext(plugin: XdevPlugin): PluginContext {
    const pluginId = plugin.metadata.id;

    // 初始化插件存储
    if (!this.storage.has(pluginId)) {
      this.storage.set(pluginId, new Map());
    }
    const pluginStorage = this.storage.get(pluginId)!;

    const pluginStorageApi: PluginStorage = {
      get: async (key: string) => pluginStorage.get(key),
      set: async (key: string, value: unknown) => {
        pluginStorage.set(key, value);
      },
      delete: async (key: string) => {
        pluginStorage.delete(key);
      },
      clear: async () => {
        pluginStorage.clear();
      },
    };

    return {
      logger: createLogger(`plugin:${pluginId}`),
      getConfig: () => {
        const loaded = this.plugins.get(pluginId);
        return loaded?.config || { enabled: true };
      },
      updateConfig: (config: Partial<PluginConfig>) => {
        const loaded = this.plugins.get(pluginId);
        if (loaded) {
          loaded.config = { ...loaded.config, ...config };
        }
      },
      emit: (event: string, data: unknown) => {
        eventBus.emit(`plugin:${pluginId}:${event}`, data);
      },
      on: (event: string, handler: (data: unknown) => void) => {
        return eventBus.on(`plugin:${pluginId}:${event}`, handler);
      },
      storage: pluginStorageApi,
    };
  }

  /**
   * 关闭所有插件
   */
  async shutdown(): Promise<void> {
    for (const [pluginId] of this.plugins) {
      await this.unload(pluginId);
    }
    logger.info('所有插件已关闭');
  }

  /**
   * 获取插件统计信息
   */
  getStats(): {
    total: number;
    loaded: number;
    enabled: number;
    error: number;
  } {
    let loaded = 0;
    let enabled = 0;
    let error = 0;

    for (const l of this.plugins.values()) {
      if (l.status === 'loaded') loaded++;
      if (l.config.enabled) enabled++;
      if (l.status === 'error') error++;
    }

    return {
      total: this.plugins.size,
      loaded,
      enabled,
      error,
    };
  }
}

/**
 * 创建插件管理器
 */
export function createPluginManager(config: PluginManagerConfig): PluginManager {
  return new PluginManager(config);
}
