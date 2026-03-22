// src/cli/gateway-cli.ts
// 小智 CLI 客户端
// 连接 Gateway 服务器，提供命令行交互

import WebSocket from 'ws';
import { createInterface } from 'readline';
import { createLogger } from '../utils/logger';

const logger = createLogger('cli');

/**
 * CLI 配置
 */
export interface CliConfig {
  // Gateway 地址
  gatewayUrl: string;
  // 认证令牌（可选）
  authToken?: string;
  // 是否启用交互模式
  interactive?: boolean;
}

/**
 * CLI 命令
 */
export interface CliCommand {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[]) => Promise<void>;
}

/**
 * 小智 CLI 客户端
 */
export class XiaozhiCLI {
  private config: Required<Omit<CliConfig, 'authToken'>> & { authToken?: string };
  private ws: WebSocket | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private requestCallbacks: Map<string, (response: unknown) => void> = new Map();
  private requestCounter: number = 0;
  private commands: Map<string, CliCommand> = new Map();
  private running: boolean = false;

  constructor(config: CliConfig) {
    this.config = {
      gatewayUrl: config.gatewayUrl || 'ws://127.0.0.1:18789',
      authToken: config.authToken,
      interactive: config.interactive ?? true,
    };

    this.registerBuiltinCommands();
  }

  /**
   * 连接 Gateway
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info(`连接 Gateway: ${this.config.gatewayUrl}`);

        this.ws = new WebSocket(this.config.gatewayUrl);

        this.ws.on('open', () => {
          logger.info('已连接到 Gateway');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (error) => {
          logger.error('WebSocket 错误:', error.message);
          if (!this.running) {
            reject(error);
          }
        });

        this.ws.on('close', () => {
          logger.info('与 Gateway 断开连接');
          this.running = false;
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    this.running = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('已断开连接');
  }

  /**
   * 启动交互模式
   */
  async startInteractive(): Promise<void> {
    this.running = true;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'xiaozhi> ',
    });

    console.log('');
    console.log('小智 CLI 客户端');
    console.log('直接输入消息与小智对话，或输入 /help 查看可用命令');
    console.log('');

    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      try {
        await this.handleInput(trimmed);
      } catch (error) {
        logger.error('命令执行错误:', error);
      }

      if (this.running) {
        this.rl?.prompt();
      }
    });

    this.rl.on('close', () => {
      console.log('再见！');
      process.exit(0);
    });
  }

  /**
   * 处理输入
   */
  private async handleInput(input: string): Promise<void> {
    // 命令格式: /command arg1 arg2 ...
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(/\s+/);
      const cmdName = parts[0];
      const args = parts.slice(1);

      const command = this.commands.get(cmdName);
      if (command) {
        await command.handler(args);
      } else {
        console.log(`未知命令: /${cmdName}`);
        console.log('输入 /help 查看可用命令');
      }
    } else {
      // 直接与小智对话
      console.log(`\n📤 发送: ${input}`);
      console.log('⏳ 等待小智回复...');
      const result = await this.sendMethod('chat', { message: input });
      if (result && typeof result === 'object') {
        const response = (result as { response?: string; success?: boolean; error?: string });
        if (response.response) {
          console.log(`\n📥 小智:\n${response.response}\n`);
        } else if (response.error) {
          console.log(`\n❌ 错误: ${response.error}\n`);
        }
      }
    }
  }

  /**
   * 发送方法调用
   */
  private async sendMethod(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('未连接到 Gateway'));
        return;
      }

      const requestId = `req-${++this.requestCounter}`;

      const request = {
        type: 'request',
        payload: {
          id: requestId,
          method,
          params,
          timestamp: Date.now(),
        },
      };

      this.requestCallbacks.set(requestId, (response) => {
        resolve(response);
      });

      this.ws.send(JSON.stringify(request));

      // 超时处理
      setTimeout(() => {
        if (this.requestCallbacks.has(requestId)) {
          this.requestCallbacks.delete(requestId);
          reject(new Error('请求超时'));
        }
      }, 30000);
    });
  }

  /**
   * 处理消息
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      if (message.type === 'response' && message.payload) {
        const { id, success, result, error } = message.payload;

        const callback = this.requestCallbacks.get(id);
        if (callback) {
          this.requestCallbacks.delete(id);
          if (success) {
            console.log(JSON.stringify(result, null, 2));
            callback(result);
          } else {
            console.log(`错误: ${error?.message || '未知错误'}`);
            callback(null);
          }
        }
      } else if (message.type === 'event') {
        this.handleEvent(message.payload);
      }
    } catch (error) {
      logger.error('解析消息错误:', error);
    }
  }

  /**
   * 处理事件
   */
  private handleEvent(event: { type: string; data: unknown }): void {
    switch (event.type) {
      case 'message:received':
        console.log('\n[消息]', JSON.stringify(event.data, null, 2));
        this.rl?.prompt();
        break;
      case 'session:started':
        console.log('\n[会话开始]', JSON.stringify(event.data, null, 2));
        this.rl?.prompt();
        break;
      default:
        console.log('\n[事件]', event.type, JSON.stringify(event.data, null, 2));
        this.rl?.prompt();
    }
  }

  /**
   * 注册内置命令
   */
  private registerBuiltinCommands(): void {
    // Help
    this.commands.set('help', {
      name: 'help',
      description: '显示帮助信息',
      usage: '/help [command]',
      handler: async (args: string[]) => {
        if (args.length > 0) {
          const cmd = this.commands.get(args[0]);
          if (cmd) {
            console.log(`/${cmd.name} - ${cmd.description}`);
            console.log(`用法: ${cmd.usage}`);
          } else {
            console.log(`未知命令: ${args[0]}`);
          }
        } else {
          console.log('可用命令:');
          for (const cmd of this.commands.values()) {
            console.log(`  /${cmd.name.padEnd(15)} - ${cmd.description}`);
          }
        }
      },
    });

    // Status
    this.commands.set('status', {
      name: 'status',
      description: '获取 Gateway 状态',
      usage: '/status',
      handler: async () => {
        await this.sendMethod('status');
      },
    });

    // Sessions
    this.commands.set('sessions', {
      name: 'sessions',
      description: '获取会话列表',
      usage: '/sessions',
      handler: async () => {
        await this.sendMethod('session.list');
      },
    });

    // Plugins
    this.commands.set('plugins', {
      name: 'plugins',
      description: '获取插件列表',
      usage: '/plugins',
      handler: async () => {
        await this.sendMethod('plugin.list');
      },
    });

    // Channels
    this.commands.set('channels', {
      name: 'channels',
      description: '获取通道状态',
      usage: '/channels',
      handler: async () => {
        await this.sendMethod('channel.status');
      },
    });

    // Config
    this.commands.set('config', {
      name: 'config',
      description: '获取配置',
      usage: '/config',
      handler: async () => {
        await this.sendMethod('config.get');
      },
    });

    // Exit
    this.commands.set('exit', {
      name: 'exit',
      description: '退出 CLI',
      usage: '/exit',
      handler: async () => {
        await this.disconnect();
      },
    });

    // Quit
    this.commands.set('quit', {
      name: 'quit',
      description: '退出 CLI (同 exit)',
      usage: '/quit',
      handler: async () => {
        await this.disconnect();
      },
    });

    // Chat - 与小智对话
    this.commands.set('chat', {
      name: 'chat',
      description: '与小智对话',
      usage: '/chat <消息内容>',
      handler: async (args: string[]) => {
        if (args.length === 0) {
          console.log('用法: /chat <消息内容>');
          console.log('示例: /chat 你好，小智');
          return;
        }
        const message = args.join(' ');
        console.log(`\n📤 发送: ${message}`);
        console.log('⏳ 等待小智回复...');
        const result = await this.sendMethod('chat', { message });
        if (result && typeof result === 'object') {
          const response = (result as { response?: string; success?: boolean; error?: string });
          if (response.response) {
            console.log(`\n📥 小智:\n${response.response}\n`);
          } else if (response.error) {
            console.log(`\n❌ 错误: ${response.error}\n`);
          }
        }
      },
    });
  }

  /**
   * 执行单个命令
   */
  async execute(command: string): Promise<void> {
    await this.handleInput(command);
  }
}

/**
 * 启动 CLI
 */
export async function startCLI(config?: Partial<CliConfig>): Promise<XiaozhiCLI> {
  const cli = new XiaozhiCLI({
    gatewayUrl: config?.gatewayUrl || process.env.XIAOZHI_GATEWAY_URL || 'ws://127.0.0.1:18789',
    authToken: config?.authToken || process.env.XIAOZHI_AUTH_TOKEN,
    interactive: config?.interactive ?? true,
  });

  await cli.connect();

  if (config?.interactive !== false) {
    await cli.startInteractive();
  }

  return cli;
}
