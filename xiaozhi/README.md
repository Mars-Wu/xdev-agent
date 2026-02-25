# 小智 (Xiaozhi) - AI 管家系统

基于 Claude CLI 的智能管家系统，通过飞书提供对话接口，拥有 AI 专家团队处理特定类型任务，支持自我升级。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                          飞书用户                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ ① WebSocket 消息
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Node.js 服务进程                            │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │               ClaudeNativeAgent（小智）                   │   │
│  │                     消息队列                               │   │
│  │   [主人@飞书] → [专家:coder] → [专家:analyst] → ...       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                  │
│  ┌──────────────────────────┴──────────────────────────────┐   │
│  │                  HTTP Server (:8081)                     │   │
│  │   POST /expert/call     - 调用专家                       │   │
│  │   POST /expert/complete - 专家完成回调                   │   │
│  │   GET  /expert/list     - 专家列表                       │   │
│  │   POST /upgrade/start   - 开始升级                       │   │
│  │   POST /upgrade/test    - 测试影子实例                   │   │
│  │   POST /upgrade/execute - 执行升级                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        │                    ▲                    ▲
        │ 飞书回复            │ spawn             │ HTTP 回调
        ▼                    │                   │
┌─────────────────┐    ┌─────┴─────┐    ┌───────┴───────┐
│    飞书用户      │    │ 代码专家   │    │  分析专家     │
│                 │    │  coder    │    │  analyst     │
└─────────────────┘    └───────────┘    └───────────────┘
```

## AI 专家团队

| 专家 | 专长 | 适用场景 |
|------|------|----------|
| **coder** | 代码编写、重构、调试 | 写代码、改代码、修 bug |
| **analyst** | 日志分析、数据诊断 | 分析日志、查问题 |
| **operator** | 系统运维、部署 | 重启服务、部署应用 |
| **researcher** | 信息收集、调研 | 技术调研、文档整理 |

## 自我升级系统

小智可以安全地升级自己，流程如下：

```
1. 准备阶段（当前小智执行）
   ├── Git 备份当前代码
   ├── 修改代码
   ├── Git commit 变更
   └── 编译新版本

2. 测试阶段
   ├── 启动影子实例 (:8090)
   ├── 发送测试消息
   ├── 检查响应
   └── 飞书通知测试结果

3. 执行阶段（tmux 守护）
   ├── tmux new -s tmux_upgradeXiaoZhi
   ├── 停止服务
   ├── 切换版本
   ├── 启动服务
   └── 健康检查

4. 完成阶段（新版小智执行）
   ├── 检查升级状态
   ├── 飞书通知结果
   └── 关闭 tmux 会话
```

### 升级 API

| 路由 | 方法 | 说明 |
|------|------|------|
| `/upgrade/status` | GET | 获取升级状态 |
| `/upgrade/start` | POST | 开始升级 |
| `/upgrade/commit` | POST | 提交代码变更 |
| `/upgrade/build` | POST | 编译代码 |
| `/upgrade/test` | POST | 测试影子实例 |
| `/upgrade/prepare` | POST | 准备升级 |
| `/upgrade/execute` | POST | 执行升级 |
| `/upgrade/abort` | POST | 放弃升级 |
| `/upgrade/history` | GET | 升级历史 |

## 目录结构

```
xiaozhi/
├── src/
│   ├── index.ts                     # 主入口
│   ├── core/
│   │   └── claude-native-agent.ts   # 小智 Agent
│   ├── expert/
│   │   └── manager.ts               # 专家管理器
│   ├── upgrade/                     # 自我升级系统
│   │   ├── types.ts                 # 类型定义
│   │   ├── recorder.ts              # 升级记录
│   │   ├── shadow.ts                # 影子实例
│   │   ├── tester.ts                # 测试消息
│   │   └── manager.ts               # 升级管理器
│   ├── worker/
│   │   └── hooks-receiver.ts        # HTTP 接收器
│   ├── feishu/                      # 飞书客户端
│   ├── storage/                     # 数据存储
│   └── utils/                       # 工具函数
└── package.json

~/.xiaozhi/
├── experts/                         # 专家配置
│   ├── coder/CLAUDE.md
│   ├── analyst/CLAUDE.md
│   ├── operator/CLAUDE.md
│   └── researcher/CLAUDE.md
├── upgrades/                        # 升级记录
│   └── 2026-02-25_001/
│       ├── state.json               # 升级状态
│       └── execute.sh               # 执行脚本
├── system-prompt.md                 # 小智提示词
└── xiaozhi.db                       # 数据库
```

## HTTP API

| 路由 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/queue` | GET | 队列状态 |
| `/expert/call` | POST | 调用专家 |
| `/expert/complete` | POST | 专家完成回调 |
| `/expert/list` | GET | 专家列表 |
| `/expert/status` | GET | 专家状态 |

## 技术特点

1. **专家系统** - 不同专家处理不同类型任务
2. **统一架构** - 小智和专家都用 `claude --print`
3. **消息队列** - 飞书和专家消息排队处理
4. **并行处理** - 小智不等待专家，专家完成后回调
5. **自我升级** - 安全升级，测试通过才执行
6. **tmux 守护** - 升级过程独立于服务进程

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
- tmux（升级功能需要）

## 许可证

MIT
