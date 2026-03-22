# 小智 (Xiaozhi) - AI 管家系统

基于 Claude CLI 的智能管家系统，通过飞书提供对话接口，拥有 AI 专家团队处理特定类型任务，支持自我升级、定时任务、Gateway 控制平面和插件系统。

## 📚 文档

- **[功能说明与部署指南](docs/GUIDE.md)** - 完整的功能模块说明、安装部署、配置和使用指南
- **[API 参考](docs/GUIDE.md#api-参考)** - HTTP API 和 Gateway WebSocket API
- **[故障排查](docs/GUIDE.md#故障排查)** - 常见问题和解决方案

## 架构概览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           通信通道                                        │
│  ┌─────────────┐              ┌─────────────┐                             │
│  │   飞书用户   │              │  CLI 客户端  │                            │
│  └──────┬──────┘              └──────┬──────┘                             │
└─────────┼────────────────────────────┼────────────────────────────────────┘
          │ ① WebSocket 消息            │ ② WebSocket 连接
          ▼                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        Gateway 控制平面 (:18789)                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  WebSocket Server                                                   │  │
│  │  • chat - 与小智对话（CLI 无状态模式）                               │  │
│  │  • session.list - 获取专家会话                                      │  │
│  │  • plugin.list - 获取插件列表                                       │  │
│  │  • channel.status - 获取通道状态                                    │  │
│  │  • config.get - 获取系统配置                                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      Node.js 服务进程                                     │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │               ClaudeNativeAgent（小智）                             │  │
│  │                     消息队列                                        │  │
│  │   [主人@飞书] → [专家:coder] → [专家:analyst] → ...                 │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                             │                                            │
│  ┌──────────────────────────┴───────────────────────────────────────┐   │
│  │                  HTTP Server (:8081)                              │   │
│  │   POST /api/experts/:name/call - 调用专家                         │   │
│  │   POST /api/callbacks/complete - 专家完成回调                     │   │
│  │   GET  /api/experts           - 专家列表                          │   │
│  │   GET  /api/cron/tasks        - 定时任务列表                      │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │                  Plugin SDK (事件总线)                             │   │
│  │   • 消息接收/发送事件                                              │   │
│  │   • 会话开始/结束事件                                              │   │
│  │   • 插件生命周期管理                                               │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
        │                    ▲                    ▲
        │ 飞书回复            │ spawn             │ HTTP 回调
        ▼                    │                   │
┌─────────────────┐    ┌─────┴─────┐    ┌───────┴───────┐
│    飞书用户      │    │ 代码专家   │    │  分析专家     │
│                 │    │  coder    │    │  analyst     │
└─────────────────┘    └───────────┘    └───────────────┘
```

## 双通道架构

小智支持两个通信通道，采用**主从模式**：

| 通道 | 定位 | 会话模式 | 用途 |
|------|------|---------|------|
| **飞书** | 主通道 | 持久化上下文 | 日常对话、任务委托、长期记忆 |
| **CLI** | 管理通道 | 无状态 | 状态查看、调试、紧急操作 |

### 通道特性对比

| 特性 | 飞书通道 | CLI 通道 |
|-----|---------|---------|
| 会话持久化 | ✅ `--continue` | ❌ 无状态 |
| 上下文累积 | ✅ 是 | ❌ 否 |
| 阻塞主会话 | ❌ 否 | ❌ 否 |
| 全局记忆 | ✅ 共享 | ✅ 共享 |

## Gateway 控制平面

WebSocket 服务器，提供实时 API 和事件推送。

### 端点

| 端点 | 说明 |
|------|------|
| `ws://127.0.0.1:18789` | WebSocket 连接 |
| `http://127.0.0.1:18789/health` | 健康检查 |

### 内置方法

| 方法 | 说明 |
|------|------|
| `ping` | 健康检查 |
| `status` | 获取 Gateway 状态 |
| `chat` | 与小智对话 |
| `session.list` | 获取专家会话列表 |
| `plugin.list` | 获取插件列表 |
| `channel.status` | 获取通道状态 |
| `config.get` | 获取系统配置 |

### CLI 客户端

```bash
# 连接 Gateway
node dist/cli/index.js

# 可用命令
/status    - 获取 Gateway 状态
/sessions  - 获取专家会话列表
/plugins   - 获取插件列表
/channels  - 获取通道状态
/config    - 获取系统配置
/chat 消息 - 与小智对话
/exit      - 退出 CLI
```

## 插件系统

基于事件总线的插件架构，支持松耦合的扩展。

### 事件类型

```typescript
enum EventTypes {
  MESSAGE_RECEIVED = 'message:received',
  MESSAGE_SENT = 'message:sent',
  SESSION_STARTED = 'session:started',
  SESSION_ENDED = 'session:ended',
  PLUGIN_LOADED = 'plugin:loaded',
  SYSTEM_START = 'system:start',
}
```

### 插件接口

```typescript
interface IPlugin {
  name: string;
  version: string;
  init(context: PluginContext): Promise<void>;
  destroy(): Promise<void>;
}
```

### 内置插件

| 插件 | 说明 |
|------|------|
| `feishu` | 飞书消息通道插件 |

## AI 专家团队

| 专家 | 专长 | 适用场景 |
|------|------|----------|
| **coder** | 代码编写、重构、调试 | 写代码、改代码、修 bug |
| **analyst** | 日志分析、数据诊断 | 分析日志、查问题 |
| **operator** | 系统运维、部署 | 重启服务、部署应用 |
| **researcher** | 信息收集、调研 | 技术调研、文档整理 |

## 目录结构

```
xiaozhi/
├── src/
│   ├── index.ts                     # 主入口
│   ├── core/
│   │   └── claude-native-agent.ts   # 小智 Agent
│   ├── gateway/                     # Gateway 控制平面
│   │   ├── server.ts                # WebSocket 服务器
│   │   └── types.ts                 # 类型定义
│   ├── plugin-sdk/                  # 插件 SDK
│   │   ├── event-bus.ts             # 事件总线
│   │   ├── manager.ts               # 插件管理器
│   │   └── types.ts                 # 类型定义
│   ├── plugins/                     # 内置插件
│   │   └── feishu/                  # 飞书插件
│   ├── cli/                         # CLI 客户端
│   │   ├── index.ts                 # CLI 入口
│   │   └── gateway-cli.ts           # Gateway CLI 实现
│   ├── expert/
│   │   ├── manager.ts               # 专家管理器
│   │   ├── executor.ts              # 专家执行器
│   │   ├── session-manager.ts       # 会话管理
│   │   ├── token-counter.ts         # Token 计数
│   │   ├── context-pruning.ts       # 上下文裁剪
│   │   ├── progress-tracker.ts      # 进度追踪 (Harness)
│   │   └── feature-list.ts          # 功能清单 (Harness)
│   ├── config/                      # 配置系统
│   │   ├── index.ts                 # 配置导出
│   │   ├── schema.ts                # 配置 Schema
│   │   └── hot-reload.ts            # 热重载
│   ├── file/                        # 文件处理模块
│   │   ├── manager.ts               # 文件管理器
│   │   └── analyzer.ts              # 文件分析器
│   ├── cron/
│   │   ├── manager.ts               # 定时任务管理器
│   │   └── types.ts                 # 类型定义
│   ├── feishu/
│   │   ├── client.ts                # 飞书客户端
│   │   ├── types.ts                 # 类型定义
│   │   ├── card-builder.ts          # 富卡片构建器
│   │   └── card-types.ts            # 卡片类型定义
│   ├── api/
│   │   └── hooks-receiver.ts        # HTTP 接收器
│   ├── monitor/
│   │   └── memory-monitor.ts        # 内存监控
│   ├── storage/
│   │   └── sqlite.ts                # SQLite 存储
│   └── utils/                       # 工具函数
└── package.json

~/.xiaozhi/
├── files/                           # 用户上传的文件存储
├── experts/                         # 专家配置
│   ├── coder/CLAUDE.md
│   ├── analyst/CLAUDE.md
│   ├── operator/CLAUDE.md
│   └── researcher/CLAUDE.md
├── workspace/                       # 小智工作目录
├── system-prompt.md                 # 小智提示词
└── xiaozhi.db                       # 数据库
```

## 定时任务系统

基于 node-cron 的定时任务管理，支持自然语言描述和回调触发。

### API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/cron/tasks` | GET | 获取定时任务列表 |
| `/api/cron/tasks` | POST | 创建定时任务 |
| `/api/cron/tasks/:id` | DELETE | 删除任务 |
| `/api/cron/tasks/:id/enable` | POST | 启用任务 |
| `/api/cron/tasks/:id/disable` | POST | 禁用任务 |

## Harness 工程特性

基于 OpenAI 和 Anthropic 的 Harness 工程最佳实践，提升长时运行 Agent 的可靠性。

### 进度追踪 (Progress Tracker)

在每个工作目录维护 `.xiaozhi-progress.md` 文件，让新 Agent 能快速了解历史工作。

### 功能清单 (Feature List)

使用 `.xiaozhi-features.json` 定义"什么算完成"，防止 Agent 提前宣布任务完成。

### Token 计数

实时估算上下文 Token 数量，支持多种模型：
- Claude 系列
- GPT 系列

### 上下文裁剪

基于优先级的消息保留策略：
- 系统消息：最高优先级
- 用户消息：高优先级
- 助手消息：普通优先级

## HTTP API

| 路由 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/experts` | GET | 专家列表 |
| `/api/experts/:name` | GET | 专家详情 |
| `/api/experts/:name/call` | POST | 调用专家 |
| `/api/callbacks/complete` | POST | 专家完成回调 |
| `/api/sessions/:id` | GET | 会话状态 |
| `/api/cron/tasks` | GET/POST | 定时任务管理 |

## 文件处理功能

用户可以通过飞书发送文件给小智，小智会自动下载、分析并存储。

### 支持的文件类型

| 类型 | 扩展名 | 处理方式 |
|------|--------|----------|
| PDF | .pdf | 提取文本内容 |
| Word | .doc, .docx | 提取文本内容 |
| Excel | .xls, .xlsx | 解析表格数据 |
| 图片 | .png, .jpg, .gif, .webp | Claude Vision 多模态分析 |

## 服务管理

```bash
systemctl --user start xiaozhi    # 启动
systemctl --user stop xiaozhi     # 停止
systemctl --user restart xiaozhi  # 重启
journalctl --user -u xiaozhi -f   # 日志
```

## 依赖

- Node.js >= 18
- SQLite3
- Claude CLI
- ws (WebSocket)
- node-cron（定时任务）

## 许可证

MIT
