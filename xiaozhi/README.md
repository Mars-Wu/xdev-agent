# AI管家小智

基于 Claude 的智能管家系统，通过飞书与用户通信，支持简单任务直接处理和复杂任务创建 Worker 处理。

## 功能特性

- **飞书集成**: 通过飞书机器人接收和发送消息
- **智能任务处理**: 自动判断任务复杂度
  - 简单任务：直接由小智处理
  - 复杂任务：创建独立 Worker 处理
- **Worker 管理**: 在 tmux 中运行 claude CLI，支持进度追踪
- **Hooks 通知**: Worker 通过 Hooks 主动通知进度，减少轮询

## 目录结构

```
xiaozhi/
├── src/
│   ├── index.ts              # 入口文件
│   ├── core/
│   │   ├── xiaozhi.ts        # 小智核心服务
│   │   └── message-handler.ts # 消息处理器
│   ├── feishu/
│   │   ├── client.ts         # 飞书客户端
│   │   └── types.ts          # 类型定义
│   ├── session/
│   │   ├── manager.ts        # 会话管理器
│   │   └── types.ts          # 类型定义
│   ├── worker/
│   │   ├── manager.ts        # Worker管理器
│   │   ├── factory.ts        # Worker工厂
│   │   ├── hooks-receiver.ts # Hooks接收器
│   │   └── types.ts          # 类型定义
│   ├── storage/
│   │   └── sqlite.ts         # SQLite存储
│   └── utils/
│       ├── tmux.ts           # tmux工具
│       └── logger.ts         # 日志工具
├── scripts/
│   ├── notify_xiaozhi.sh     # 通知脚本
│   ├── worker_completed.sh   # 完成脚本
│   └── subagent_notify.sh    # 子代理通知
├── config/
│   └── config.yaml           # 配置文件
├── package.json
├── tsconfig.json
├── xiaozhi.service           # Systemd服务
├── install-xiaozhi.sh        # 安装脚本
└── .env.example              # 环境变量示例
```

## 快速开始

### 1. 安装依赖

```bash
cd xiaozhi
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填写飞书配置
```

必填配置：
- `FEISHU_APP_ID`: 飞书应用 ID
- `FEISHU_APP_SECRET`: 飞书应用密钥

### 3. 编译

```bash
npm run build
```

### 4. 运行

开发模式：
```bash
npm run dev
```

生产模式：
```bash
npm start
```

## Systemd 部署

### 一键安装

```bash
sudo ./install-xiaozhi.sh
```

### 手动安装

1. 创建用户和目录：
```bash
sudo useradd -r -s /bin/bash xiaozhi
sudo mkdir -p /var/lib/xiaozhi/{data,workers,scripts}
sudo mkdir -p /var/log/xiaozhi
```

2. 复制文件：
```bash
sudo cp -r dist package.json node_modules /opt/xiaozhi/
sudo cp scripts/*.sh /var/lib/xiaozhi/scripts/
sudo chmod +x /var/lib/xiaozhi/scripts/*.sh
```

3. 创建环境配置：
```bash
sudo mkdir -p /etc/xiaozhi
sudo cp .env.example /etc/xiaozhi/environment
# 编辑 /etc/xiaozhi/environment
```

4. 安装服务：
```bash
sudo cp xiaozhi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable xiaozhi
sudo systemctl start xiaozhi
```

### 管理命令

```bash
# 启动
sudo systemctl start xiaozhi

# 停止
sudo systemctl stop xiaozhi

# 查看状态
sudo systemctl status xiaozhi

# 查看日志
sudo journalctl -u xiaozhi -f
```

## 使用说明

### 基本对话

直接发送消息，小智会处理并回复：
```
用户: 你好
小智: 你好！我是AI管家小智 👋 有什么我可以帮你的吗？
```

### 命令

- `/help` 或 `/帮助` - 显示帮助
- `/worker list` - 列出所有 Worker
- `/worker progress <id>` - 查看 Worker 进度
- `/worker stop <id>` - 停止 Worker
- `/status` - 查看会话状态

### Worker 自动创建

当任务复杂度较高时，小智会自动创建 Worker：

```
用户: 帮我重构整个认证模块
小智: 这是一个复杂任务，我将创建一个 Worker 来处理...

🚀 Worker已创建
名称: Worker-abc123
ID: w_abc123
状态: 运行中
```

## 健康检查

```bash
curl http://localhost:8081/health
```

## 依赖

- Node.js >= 18
- tmux
- jq (用于 Hook 脚本)
- SQLite3

## 许可证

MIT
