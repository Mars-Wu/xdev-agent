#!/usr/bin/env node
// bin/xiaozhi-cli.ts
// 小智 CLI 客户端入口

import { startCLI } from '../src/cli';

// 解析命令行参数
const args = process.argv.slice(2);
let gatewayUrl: string | undefined;
let command: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--gateway' || arg === '-g') {
    gatewayUrl = args[++i];
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
小智 CLI 客户端

用法: xiaozhi-cli [选项] [命令]

选项:
  -g, --gateway <url>  Gateway 地址 (默认: ws://127.0.0.1:18789)
  -h, --help           显示帮助信息

命令:
  直接输入命令将在连接后执行
  如果不提供命令，将进入交互模式

环境变量:
  XIAOZHI_GATEWAY_URL  Gateway 地址
  XIAOZHI_AUTH_TOKEN   认证令牌

示例:
  xiaozhi-cli                          # 交互模式
  xiaozhi-cli -g ws://localhost:18789  # 指定 Gateway
  xiaozhi-cli "/status"                # 执行单个命令
`);
    process.exit(0);
  } else if (!arg.startsWith('-')) {
    command = arg;
  }
}

// 启动 CLI
startCLI({
  gatewayUrl,
  interactive: !command,
})
  .then(async (cli) => {
    if (command) {
      // 执行单个命令后退出
      const { XiaozhiCLI } = await import('../src/cli');
      const cliInstance = cli as unknown as XiaozhiCLI;
      await cliInstance.execute(command);
      await cliInstance.disconnect();
    }
  })
  .catch((error) => {
    console.error('启动失败:', error.message);
    process.exit(1);
  });
