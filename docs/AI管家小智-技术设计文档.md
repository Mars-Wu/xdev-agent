# AI管家小智 - 技术设计文档

## 1. 需求概述

### 1.1 项目目标
构建一个与飞书通信的 **AI管家小智**，基于 Claude Agent SDK 实现，作为用户的智能助手：
- 接收飞书消息，与用户沟通
- 处理一般性事务（简单任务直接处理）
- 创建 tmux + claude AI Worker 处理复杂长期任务
- 通过 Claude Hooks 机制接收 Worker 进度通知（减少 token 消耗）

### 1.2 核心需求

#### 功能需求
| ID | 需求 | 优先级 | 说明 |
|----|------|--------|------|
| F1 | 飞书消息收发 | P0 | 通过飞书SDK接收用户消息、发送回复 |
| F2 | 小智直接处理简单任务 | P0 | 作为Claude Agent处理问答、文件读取、简单编辑等 |
| F3 | 创建Worker处理复杂任务 | P0 | 在tmux中启动claude CLI处理长期任务 |
| F4 | Claude Hooks进度通知 | P0 | Worker通过Hooks主动通知小智进度 |
| F5 | 会话管理 | P1 | 多会话支持、上下文管理 |
| F6 | Worker生命周期管理 | P1 | 创建、监控、暂停、终止 |
| F7 | Token优化 | P1 | 历史压缩、通知节流 |

#### 非功能需求
| ID | 需求 | 说明 |
|----|------|------|
| NF1 | Systemd部署 | 作为系统服务运行，开机自启 |
| NF2 | 高可用 | 自动重启、状态持久化 |
| NF3 | 可观测 | 日志记录、状态监控 |

### 1.3 技术选型

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | Node.js + TypeScript | 与飞书SDK兼容 |
| AI核心 | Claude Agent SDK | 程序化使用Claude |
| 飞书通信 | @larksuiteoapi/node-sdk | 官方SDK |
| Worker进程 | tmux + claude CLI | 独立Claude实例 |
| 进度通知 | Claude Hooks | SubagentStop/Notification事件 |
| 数据存储 | SQLite | 轻量级持久化 |
| 进程管理 | Systemd | Linux系统服务 |

---

## 2. 系统架构

### 2.1 系统角色
```
用户 ←→ 飞书机器人 ←→ AI管家小智(Claude Agent) ←→ Claude AI Workers
                              ↓                           ↓
                        会话管理器                   Claude Hooks → 进度通知
```

### 2.2 整体架构图
```
┌─────────────────────────────────────────────────────────────────────┐
│                            用户 - 飞书APP                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ WebSocket长连接
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AI管家小智 (Claude Agent SDK)                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Claude Agent (claude-sonnet-4-5)                            │   │
│  │  - 理解用户意图 / 处理简单任务 / 判断复杂度 / 管理Worker        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  会话管理器   │  │ Worker管理器  │  │  飞书适配器   │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│  ┌──────────────┐  ┌──────────────┐                                 │
│  │  Hook接收器   │  │  状态存储     │                                 │
│  └──────────────┘  └──────────────┘                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ 创建/监控
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ Claude Worker│      │ Claude Worker│      │ Claude Worker│
│   (tmux)     │      │   (tmux)     │      │   (tmux)     │
│ claude CLI   │      │ claude CLI   │      │ claude CLI   │
│ + Hooks      │──────│ + Hooks      │──────│ + Hooks      │
└──────────────┘      └──────────────┘      └──────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │ HTTP回调通知小智
                              ▼
```

### 2.3 任务处理流程

```
用户消息 → AI小智 (Claude Agent)
              │
              ├── 🟢 简单任务 → 直接处理
              │   ├── 问答/咨询
              │   ├── 代码分析
              │   ├── 文件读取
              │   ├── 简单编辑
              │   └── 信息查询
              │
              ├── 🟡 中等任务 → 询问后决定
              │   ├── 多文件修改
              │   └── 需要运行测试
              │
              └── 🔴 复杂任务 → 创建Worker
                  ├── 大规模重构
                  ├── 长时间运行
                  └── 需要独立进度追踪
```

---

## 3. 核心功能模块

### 3.1 飞书通信层

**职责**: 处理与飞书的双向通信

```typescript
import * as lark from '@larksuiteoapi/node-sdk';

// 创建飞书客户端（长连接模式）
const feishuClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

// WebSocket长连接接收消息
const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      await xiaozhi.handleMessage({
        chatId: data.message.chat_id,
        userId: data.sender.sender_id.user_id,
        content: JSON.parse(data.message.content),
      });
    },
  }),
});
```

### 3.2 AI小智核心 (Claude Agent)

**职责**: 作为Claude Agent处理用户请求

```typescript
import { ClaudeAgent } from '@anthropic/claude-agent-sdk';

const xiaozhiAgent = new ClaudeAgent({
  model: 'claude-sonnet-4-5-20250929',
  systemPrompt: `你是AI管家小智，负责：
1. 与用户通过飞书沟通
2. 处理简单任务（问答、文件读取、简单编辑）
3. 判断任务复杂度，必要时创建Claude Worker
4. 管理和监控Claude Worker的运行状态`,
  tools: [
    'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',  // Claude内置工具
    'spawn_worker', 'check_worker', 'terminate_worker', // 自定义Worker管理
  ],
});
```

### 3.3 Claude Hooks进度通知

**设计**: Worker通过Hooks主动通知小智，避免轮询

```json
// Worker的Hooks配置
{
  "hooks": {
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "notify_xiaozhi.sh" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "worker_completed.sh" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "subagent_notify.sh" }] }]
  }
}
```

### 3.4 Worker管理器

**职责**: 在tmux中创建和管理claude CLI Worker

```typescript
class WorkerManager {
  async spawnWorker(config: WorkerConfig): Promise<ClaudeWorker> {
    // 1. 创建Worker目录和Hooks配置
    // 2. 创建tmux会话
    // 3. 启动claude CLI (--print --dangerously-skip-permissions)
    // 4. 记录Worker元数据
  }
}
```

---

## 4. 数据存储设计

```
/var/lib/xiaozhi/
├── data/
│   └── xiaozhi.db              # SQLite数据库
├── workers/
│   ├── worker_xxx/
│   │   ├── meta.json           # Worker元数据
│   │   ├── output.log          # 输出日志
│   │   └── .claude/settings.json # Hooks配置
│   └── ...
├── scripts/
│   ├── notify_xiaozhi.sh       # 通知脚本
│   ├── worker_completed.sh     # 完成脚本
│   └── subagent_notify.sh      # 子代理通知
└── config/
    └── config.yaml             # 配置文件
```

---

## 5. Token优化策略

| 策略 | 说明 |
|------|------|
| 对话历史压缩 | 定期将历史对话压缩为摘要 |
| Hooks通知 | 使用Hooks主动通知，避免轮询 |
| 通知节流 | 非关键进度延迟/批量报告 |
| 按需推送 | 根据用户偏好控制通知频率 |

---

## 6. 部署方案（Systemd）

### 6.1 服务配置

```ini
# /etc/systemd/system/xiaozhi.service
[Unit]
Description=AI管家小智服务
After=network.target

[Service]
Type=simple
User=xiaozhi
Group=xiaozhi
WorkingDirectory=/opt/xiaozhi
ExecStart=/usr/bin/node /opt/xiaozhi/dist/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/etc/xiaozhi/environment
LimitNOFILE=65535
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

### 6.2 管理命令

```bash
sudo systemctl start xiaozhi    # 启动
sudo systemctl stop xiaozhi     # 停止
sudo systemctl status xiaozhi   # 状态
sudo journalctl -u xiaozhi -f   # 日志
```

---

## 7. 风险评估

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|----------|
| Hooks通知延迟 | 中 | 中 | 增加备用轮询机制 |
| Token消耗过大 | 中 | 中 | 实施压缩策略，监控用量 |
| Worker执行超时 | 中 | 中 | 设置合理超时，支持续接 |

---

## 8. 参考资源

- [Claude CLI参考](https://code.claude.com/docs/zh-CN/cli-reference)
- [Claude Hooks指南](https://code.claude.com/docs/zh-CN/hooks-guide)
- [飞书Node SDK](https://github.com/larksuite/node-sdk)

---

**文档版本**: v2.1
**更新日期**: 2026-02-18
