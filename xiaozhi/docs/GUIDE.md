# 小智 (Xiaozhi) - 功能说明与部署指南

本文档详细介绍小智 AI 管家系统的功能模块、安装部署和使用方法。

## 目录

- [系统概述](#系统概述)
- [功能模块](#功能模块)
- [环境要求](#环境要求)
- [安装部署](#安装部署)
- [配置说明](#配置说明)
- [使用指南](#使用指南)
- [API 参考](#api-参考)
- [故障排查](#故障排查)

---

## 系统概述

小智是一个基于 Zhipu GLM API 的智能管家系统（通过 Anthropic SDK 兼容接口调用），主要特点：

- **双通道架构**：飞书（主通道）+ CLI（管理通道）
- **Gateway 控制平面**：WebSocket 实时 API
- **插件系统**：事件总线驱动的可扩展架构
- **定时任务**：Cron 表达式定时触发
- **文件处理**：支持 PDF/Word/Excel/图片智能分析

---

## 功能模块

### 1. 核心模块 (Core)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `llm-client.ts` | LLM 客户端 | Anthropic SDK 封装，调用 Zhipu GLM API |
| `agent-loop.ts` | Agent 循环 | 带工具调用的完整 LLM 交互循环 |
| `message-history.ts` | 消息历史 | 会话上下文管理、压缩与恢复 |
| `message-router.ts` | 消息路由 | 话题感知上下文路由（Stage 1 路由器）|

**主要功能**：
- 消息队列处理（飞书、Worker、Gateway）
- 基于 GLM API 的流式 LLM 调用
- 会话压缩与恢复
- 话题级别的上下文隔离

### 2. Gateway 模块

| 文件 | 功能 | 说明 |
|-----|------|------|
| `server.ts` | WebSocket 服务器 | 控制平面，提供实时 API |
| `types.ts` | 类型定义 | 方法、事件、错误码定义 |

**内置方法**：

| 方法 | 说明 |
|-----|------|
| `ping` | 健康检查 |
| `status` | Gateway 状态 |
| `chat` | 与小智对话（无状态） |
| `session.list` | 专家会话列表 |
| `plugin.list` | 插件列表 |
| `channel.status` | 通道状态 |
| `config.get` | 系统配置 |

### 3. 插件 SDK (Plugin SDK)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `event-bus.ts` | 事件总线 | 发布/订阅模式的事件系统 |
| `manager.ts` | 插件管理器 | 插件生命周期管理 |
| `types.ts` | 类型定义 | 插件接口定义 |

**事件类型**：

| 事件 | 触发时机 |
|-----|---------|
| `message:received` | 收到消息 |
| `message:sent` | 发送消息 |
| `session:started` | 会话开始 |
| `session:ended` | 会话结束 |
| `plugin:loaded` | 插件加载 |
| `system:start` | 系统启动 |

### 4. Agent 模块 (Agent)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `in-process-agent.ts` | 进程内子 Agent | 隔离执行，供主 Agent 调用 |
| `index.ts` | Agent 模块入口 | 导出 Agent 相关接口 |

> **TODO / 未实现**：多专家系统（9 位专家分工）在早期设计中规划，但目前尚未实现。当前使用单一 Agent 循环处理所有任务。

### 5. 配置系统 (Config)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `index.ts` | 配置管理 | 统一配置入口 |
| `schema.ts` | 配置 Schema | Zod 验证规则 |
| `hot-reload.ts` | 热重载 | 配置变更监听 |

### 6. 飞书模块 (Feishu)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `client.ts` | 飞书客户端 | WebSocket 消息收发 |
| `card-builder.ts` | 卡片构建器 | 富消息卡片 |
| `types.ts` | 类型定义 | 消息、事件类型 |

### 7. 定时任务 (Cron)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `manager.ts` | 任务管理器 | Cron 表达式解析、任务调度 |
| `types.ts` | 类型定义 | 任务结构定义 |

### 8. 文件处理 (File)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `manager.ts` | 文件管理器 | 下载、存储、元数据 |
| `analyzer.ts` | 文件分析器 | 多格式解析 |

**支持格式**：

| 类型 | 扩展名 | 处理库 |
|-----|--------|-------|
| PDF | .pdf | pdf-parse |
| Word | .doc, .docx | mammoth |
| Excel | .xls, .xlsx | xlsx |
| 图片 | .png, .jpg, .gif, .webp | Claude Vision |

### 9. 存储模块 (Storage)

| 文件 | 功能 | 说明 |
|-----|------|------|
| `sqlite.ts` | SQLite 存储 | 持久化数据存储 |

**数据表**：
- `cron_tasks` - 定时任务
- `files` - 文件元数据
- `expert_sessions` - 专家会话

### 10. CLI 客户端

| 文件 | 功能 | 说明 |
|-----|------|------|
| `gateway-cli.ts` | CLI 实现 | 命令行交互客户端 |
| `index.ts` | CLI 入口 | 启动入口 |

---

## 环境要求

### 必需环境

| 依赖 | 版本要求 | 说明 |
|-----|---------|------|
| Node.js | >= 18.0.0 | 运行环境 |
| npm | >= 9.0.0 | 包管理器 |
| SQLite3 | >= 3.0 | 数据存储 |

### 可选依赖

| 依赖 | 用途 |
|-----|------|
| tmux | 升级守护进程 |
| systemd | 服务管理 |

### 检查环境

```bash
# 检查 Node.js
node --version  # 应 >= v18.0.0

# 检查 SQLite
sqlite3 --version
```

---

## 安装部署

### 方式一：从源码安装

```bash
# 1. 克隆代码
cd ~/data/claudeClaw
git clone <repo-url> xiaozhi
cd xiaozhi

# 2. 安装依赖
npm install

# 3. 编译 TypeScript
npm run build

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env 填入飞书应用凭证

# 5. 初始化目录
mkdir -p ~/.xiaozhi/{files,experts,workspace}
```

### 方式二：Systemd 服务部署

```bash
# 1. 复制服务文件
cp xiaozhi.service ~/.config/systemd/user/

# 2. 重载 systemd
systemctl --user daemon-reload

# 3. 启用并启动服务
systemctl --user enable xiaozhi
systemctl --user start xiaozhi

# 4. 检查状态
systemctl --user status xiaozhi

# 5. 查看日志
journalctl --user -u xiaozhi -f
```

### 服务管理命令

```bash
# 启动
systemctl --user start xiaozhi

# 停止
systemctl --user stop xiaozhi

# 重启
systemctl --user restart xiaozhi

# 查看状态
systemctl --user status xiaozhi

# 查看日志（实时）
journalctl --user -u xiaozhi -f

# 查看最近 100 行日志
journalctl --user -u xiaozhi -n 100
```

---

## 配置说明

### 环境变量

创建 `.env` 文件：

```bash
# 飞书应用配置（必需）
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxx

# Gateway 配置
XIAOZHI_GATEWAY_HOST=127.0.0.1
XIAOZHI_GATEWAY_PORT=18789

# HTTP 接收器端口
XIAOZHI_HOOKS_PORT=8081

# 模型配置（使用 Zhipu GLM API）
ZHIPU_API_KEY=your_zhipu_api_key_here
XIAOZHI_MODEL=glm-5-turbo
XIAOZHI_ROUTER_MODEL=glm-4.7-flash
XIAOZHI_SELECTOR_MODEL=glm-4.7-flash
XIAOZHI_BACKGROUND_MODEL=glm-4.7-flash

# 性能配置
XIAOZHI_TIMEOUT=120000
XIAOZHI_MAX_RETRIES=3
XIAOZHI_MAX_CONCURRENT=5
```

### 系统提示词

系统提示词存储在 `~/.xiaozhi/system-prompt.md`，可自定义小智的行为和人格。

---

## 使用指南

### 飞书通道（主通道）

1. 在飞书中找到小智机器人
2. 直接发送消息
3. 小智会持久化记住对话上下文

**特殊命令**：

| 命令 | 说明 |
|-----|------|
| `/compact` | 压缩会话上下文 |
| `/stats` | 查看会话统计 |
| `/health` | 健康检查 |
| `/reset` | 重置会话 |
| `/files` | 列出文件 |
| `/delete <文件名>` | 删除文件 |

### CLI 通道（管理通道）

```bash
# 启动 CLI
node dist/cli/index.js

# 或使用 npm
npm run cli
```

**可用命令**：

| 命令 | 说明 |
|-----|------|
| `/status` | Gateway 状态 |
| `/sessions` | 专家会话列表 |
| `/plugins` | 插件列表 |
| `/channels` | 通道状态 |
| `/config` | 系统配置 |
| `/chat <消息>` | 与小智对话 |
| `/help` | 帮助信息 |
| `/exit` | 退出 CLI |

**直接对话**：不输入 `/` 开头的内容会直接发送给小智。

### Gateway API

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:18789');

// 调用方法
ws.send(JSON.stringify({
  type: 'request',
  payload: {
    id: 'req-1',
    method: 'status',
    params: {},
    timestamp: Date.now()
  }
}));

// 接收响应
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'response') {
    console.log(msg.payload.result);
  }
});
```

---

## API 参考

### HTTP API

**基础 URL**: `http://localhost:8081`

| 路由 | 方法 | 说明 |
|-----|------|------|
| `/health` | GET | 健康检查 |
| `/api/experts` | GET | 专家列表 |
| `/api/experts/:name` | GET | 专家详情 |
| `/api/experts/:name/call` | POST | 调用专家 |
| `/api/callbacks/complete` | POST | 专家完成回调 |
| `/api/sessions/:id` | GET | 会话状态 |
| `/api/cron/tasks` | GET | 定时任务列表 |
| `/api/cron/tasks` | POST | 创建定时任务 |
| `/api/cron/tasks/:id` | DELETE | 删除任务 |

### Gateway API

**WebSocket URL**: `ws://127.0.0.1:18789`

**消息格式**：

```typescript
// 请求
{
  type: 'request',
  payload: {
    id: string;        // 请求 ID
    method: string;    // 方法名
    params: object;    // 参数
    timestamp: number; // 时间戳
  }
}

// 响应
{
  type: 'response',
  payload: {
    id: string;        // 对应请求 ID
    success: boolean;  // 是否成功
    result?: any;      // 结果
    error?: {          // 错误信息
      code: string;
      message: string;
    }
  }
}

// 事件
{
  type: 'event',
  payload: {
    type: string;      // 事件类型
    data: any;         // 事件数据
    timestamp: number; // 时间戳
  }
}
```

---

## 故障排查

### 常见问题

#### 1. 服务启动失败

```bash
# 检查日志
journalctl --user -u xiaozhi -n 50

# 常见原因：
# - 缺少环境变量（检查 .env，特别是 ZHIPU_API_KEY）
# - 端口被占用（检查 8081, 18789）
```

#### 2. 飞书消息无响应

```bash
# 检查飞书连接状态
node dist/cli/index.js
> /channels

# 检查飞书凭证
# 确认 FEISHU_APP_ID 和 FEISHU_APP_SECRET 正确
```

#### 3. Gateway 无法连接

```bash
# 检查 Gateway 状态
curl http://127.0.0.1:18789/health

# 检查端口
netstat -tlnp | grep 18789
```

#### 4. 专家调用失败

```bash
# 检查专家状态
node dist/cli/index.js
> /sessions

# 检查专家配置
ls ~/.xiaozhi/experts/
```

### 日志级别

在 `.env` 中设置：

```bash
LOG_LEVEL=debug  # debug, info, warn, error
```

### 重置系统

```bash
# 停止服务
systemctl --user stop xiaozhi

# 清理会话（可选）
rm -rf ~/.xiaozhi/workspace/*.jsonl

# 重启服务
systemctl --user start xiaozhi
```

---

## 目录结构

```
xiaozhi/
├── src/
│   ├── index.ts                 # 主入口
│   ├── core/                    # 核心模块（LLM 客户端、Agent 循环、消息路由）
│   ├── agent/                   # Agent 模块（in-process-agent）
│   ├── gateway/                 # Gateway 控制平面
│   ├── plugin-sdk/              # 插件 SDK
│   ├── plugins/                 # 内置插件
│   ├── cli/                     # CLI 客户端
│   ├── config/                  # 配置系统
│   ├── feishu/                  # 飞书模块
│   ├── cron/                    # 定时任务
│   ├── file/                    # 文件处理
│   ├── storage/                 # 存储模块
│   ├── api/                     # HTTP API
│   ├── monitor/                 # 监控模块
│   └── utils/                   # 工具函数
├── dist/                        # 编译输出
├── docs/                        # 文档
├── package.json
├── tsconfig.json
└── vitest.config.ts

~/.xiaozhi/
├── files/                       # 用户文件
├── topics/                      # 话题级历史分桶
├── workspace/                   # 工作目录
├── system-prompt.md             # 系统提示词
└── xiaozhi.db                   # 数据库

~/.config/systemd/user/
└── xiaozhi.service              # 服务配置
```

---

## 更新日志

### v3.1.0
- 新增 Gateway 控制平面
- 新增插件 SDK 和事件总线
- 新增 CLI 客户端
- 实现双通道架构
- 优化 any 类型使用
- 更新文档

### v3.0.0
- 重构为 Claude Native 架构
- 新增专家系统
- 新增定时任务
- 新增文件处理

---

## 联系方式

如有问题，请通过飞书联系小智或提交 Issue。
