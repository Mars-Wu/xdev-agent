# AI管家艾克斯 - 架构说明文档

> 更新时间: 2026-03-01
> 版本: v3.1

---

## 1. 项目概述

**艾克斯 (Xdev)** 是一个基于 Claude CLI 的智能管家系统，通过飞书提供对话接口，拥有 AI 专家团队处理特定类型任务。

### 1.1 技术栈

| 组件 | 技术选型 | 版本 |
|------|---------|------|
| 语言 | TypeScript | 5.3.3 |
| 运行时 | Node.js | >= 18.0.0 |
| Web框架 | Express.js | 4.18.2 |
| 数据库 | SQLite (better-sqlite3) + FTS5 | - |
| 消息平台 | 飞书 SDK (@larksuiteoapi/node-sdk) | - |
| 进程管理 | tmux | - |
| AI 核心 | Claude CLI | - |

### 1.2 主要功能

- 飞书消息收发（WebSocket 长连接）
- 消息队列处理（支持飞书/Worker/专家消息）
- 专家系统（多类型专家协作）
- AI Worker 管理（tmux 会话隔离）
- 会话持久化和压缩
- HTTP Hooks 接收器
- **FTS5 全文搜索**（v3.1 新增）
- **记忆压缩系统**（v3.1 新增）
- **生命周期钩子**（v3.1 新增）

---

## 2. 项目结构

```
claudeClaw/
├── xdev/                          # 艾克斯主项目
│   ├── src/                          # 源代码
│   │   ├── index.ts                  # 主入口
│   │   ├── config.ts                 # 统一配置管理
│   │   ├── core/
│   │   │   └── claude-native-agent.ts # 核心 Agent（消息队列、Claude 调用、记忆压缩）
│   │   ├── api/
│   │   │   └── hooks-receiver.ts     # HTTP API 服务器（专家管理、钩子）
│   │   ├── feishu/
│   │   │   ├── client.ts             # 飞书 WebSocket 客户端
│   │   │   └── types.ts              # 飞书消息类型
│   │   ├── expert/
│   │   │   ├── manager.ts            # 专家管理器
│   │   │   ├── executor.ts           # 专家执行器
│   │   │   ├── session-manager.ts    # 专家会话管理
│   │   │   └── types.ts              # 专家类型定义
│   │   ├── monitor/
│   │   │   ├── memory-monitor.ts     # 内存监控定时任务
│   │   │   └── index.ts              # 监控模块导出
│   │   ├── storage/
│   │   │   └── sqlite.ts             # SQLite 存储层（FTS5、记忆压缩）
│   │   └── utils/
│   │       ├── logger.ts             # 日志工具
│   │       ├── errors.ts             # 错误处理
│   │       └── shell-utils.ts        # Shell 工具
│   ├── config/
│   │   └── config.yaml               # 配置文件
│   └── install-xdev.sh            # 安装脚本
├── docs/                             # 文档目录
│   └── AI管家艾克斯-架构说明.md        # 架构文档
└── CLAUDE.md                         # 项目说明（符号链接）
```

---

## 3. 核心架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          飞书用户                                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ ① WebSocket 消息
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Node.js 服务进程 (:8081)                        │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │               ClaudeNativeAgent（艾克斯核心）                    │   │
│  │                                                              │   │
│  │   消息队列: [主人@飞书] → [Worker消息] → [专家消息]            │   │
│  │                                                              │   │
│  │   处理流程:                                                   │   │
│  │   1. 消息入队（队列容量: 100）                                  │   │
│  │   2. 顺序处理（重试: 3次，超时: 2分钟）                         │   │
│  │   3. 调用 Claude CLI (--continue 模式)                        │   │
│  │   4. 飞书回复                                                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                             │                                      │
│  ┌──────────────────────────┴──────────────────────────────────┐   │
│  │                  HTTP Server (:8081)                         │   │
│  │                                                              │   │
│  │   POST /expert/call     - 调用专家                           │   │
│  │   POST /expert/complete - 专家完成回调                       │   │
│  │   GET  /expert/list     - 专家列表                           │   │
│  │   GET  /expert/status   - 专家状态                           │   │
│  │   POST /expert/message  - 专家间通信                         │   │
│  │   GET  /queue           - 消息队列状态                       │   │
│  │   GET  /health          - 健康检查                           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │  FeishuClient   │  │  ExpertManager  │  │ MemoryMonitor   │     │
│  │  (飞书 WebSocket)│  │  (专家系统)      │  │  (内存监控)      │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│           │                   │                    │               │
│           └───────────────────┴────────────────────┘               │
│                               │                                    │
│                      ┌────────┴────────┐                          │
│                      │  SQLiteStorage  │                          │
│                      │  (数据持久化)    │                          │
│                      └─────────────────┘                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 消息处理流程

```
飞书消息 → FeishuClient (WebSocket)
         → ClaudeNativeAgent.handleMessage()
         → 消息入队 (队列容量 100)
         → processQueue() 顺序处理
         → callClaudeWithRetry() (重试3次，指数退避)
         → spawn claude --print --continue
         → 解析响应 (stream-json 格式)
         → 飞书回复
```

### 3.3 专家调用流程

```
艾克斯 → POST /expert/call {expert, task, workDir}
     → ExpertManager.callExpert()
     → 参数验证（路径、任务长度）
     → 递归调用检测
     → 并发限制检查（最大5个）
     → spawn claude --print --dangerously-skip-permissions
     → 专家执行（超时30分钟）
     → POST /expert/complete
     → 艾克斯收到结果（入队处理）
```

---

## 4. 核心模块详解

### 4.1 ClaudeNativeAgent（核心 Agent）

**文件**: `src/core/claude-native-agent.ts`

**职责**:
- 消息队列管理（飞书/Worker/专家消息）
- Claude CLI 调用（带重试机制）
- 会话健康检查和压缩
- 进程生命周期管理

**关键特性**:
- 队列容量限制：100 条消息
- 重试机制：3 次，指数退避
- 超时保护：2 分钟（可配置）
- 会话压缩：超过 5MB 自动提醒

**特殊命令**:
| 命令 | 说明 |
|------|------|
| `/compact` | 压缩会话历史 |
| `/stats` | 查看会话统计 |
| `/health` | 检查会话健康 |
| `/reset` | 重置会话 |

### 4.2 FeishuClient（飞书客户端）

**文件**: `src/feishu/client.ts`

**职责**:
- WebSocket 长连接管理
- 消息收发（文本/卡片）
- 自动重连（指数退避）

**重连配置**:
- 最大重连次数：10
- 初始延迟：1秒
- 最大延迟：30秒
- 退避因子：2

**消息去重**:
- 缓存大小：1000 条消息 ID

### 4.3 ExpertManager（专家管理器）

**文件**: `src/expert/manager.ts`

**职责**:
- 专家配置加载
- 任务推荐算法
- 专家进程管理
- 专家间通信

**安全特性**:
- 路径验证（只允许主目录和 /tmp）
- 任务长度限制（10000 字符）
- 递归调用检测（防止专家调用专家）
- 并发限制（最大 5 个）
- 超时保护（30 分钟）

**专家类型**:
| 专家 | 专长领域 |
|------|---------|
| coder | 代码编写、重构、调试 |
| analyst | 日志分析、数据诊断 |
| operator | 系统运维、部署 |
| researcher | 信息收集、调研 |

### 4.4 WorkerManager（Worker 管理）

**文件**: `src/worker/manager.ts`

**职责**:
- Worker 创建和启动
- 状态监控和同步
- 优雅终止

**Worker 生命周期**:
```
pending → running → completed/failed
                ↘ paused
```

### 4.5 SQLiteStorage（数据存储）

**文件**: `src/storage/sqlite.ts`

**数据表**:
- `sessions`: 用户会话
- `workers`: Worker 状态
- `experts`: 专家配置
- `expert_sessions`: 专家会话记录
- `memories`: 记忆压缩存储（v3.1 新增）
- `session_fts`: FTS5 全文搜索虚拟表（v3.1 新增）

**性能优化**:
- WAL 模式
- 繁忙超时：5秒

**v3.1 新增功能**:

#### FTS5 全文搜索

```typescript
// 搜索会话
storage.searchSessions('关键词', 20);

// 按专家名搜索
storage.searchSessionsByExpert('coder', 20);
```

#### 记忆压缩

```typescript
// 记忆类型
SQLiteStorage.MEMORY_TYPES = {
  USER_PREFERENCE: 'user_preference',    // 用户偏好
  IMPORTANT_DECISION: 'important_decision', // 重要决策
  UNFINISHED_TASK: 'unfinished_task',    // 未完成任务
  KEY_OBSERVATION: 'key_observation',    // 关键观察
};

// 保存记忆
storage.saveMemory({
  id: 'unique-id',
  type: 'user_preference',
  key: 'pref_theme',
  value: '用户偏好深色主题',
  importance: 2
});

// 获取重要记忆
storage.getImportantMemories(20);
```

### 4.6 HooksReceiver（HTTP 接收器）

**文件**: `src/api/hooks-receiver.ts`

**API 接口**:
| 路由 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/health/detailed` | GET | 详细健康检查 |
| `/api/experts` | GET | 专家列表 |
| `/api/experts` | POST | 创建专家 |
| `/api/experts/:name` | GET | 获取专家详情 |
| `/api/experts/:name` | DELETE | 删除专家 |
| `/api/experts/:name/call` | POST | 调用专家 |
| `/api/experts/:name/sessions` | GET | 获取专家会话历史 |
| `/api/sessions/:id` | GET | 获取会话状态 |
| `/api/sessions/:id/stop` | POST | 停止会话 |
| `/api/callbacks/complete` | POST | 专家完成回调 |
| `/api/hooks` | GET | 列出钩子配置（v3.1 新增） |
| `/api/hooks/trigger` | POST | 触发钩子（v3.1 新增） |
| `/api/hooks/:type/register` | POST | 注册钩子处理器（v3.1 新增） |
| `/test/message` | POST | 测试消息 |

**v3.1 新增 - 生命周期钩子**:

```typescript
// 钩子类型
type HookType =
  | 'session_start'    // 会话开始
  | 'user_prompt'      // 用户发送消息
  | 'post_tool'        // 工具调用后
  | 'session_end'      // 会话结束
  | 'expert_complete'; // 专家完成

// 触发钩子
hooksReceiver.triggerHook('session_start', sessionId, { user: 'wxy' });

// 注册钩子处理器
POST /api/hooks/session_start/register
{
  "handlerUrl": "http://localhost:3000/webhook"
}
```

---

## 5. 配置管理

### 5.1 配置优先级

```
~/.claude/settings.json > 环境变量 > config.yaml > 代码默认值
```

### 5.2 关键配置项

| 配置项 | 环境变量 | 默认值 |
|--------|---------|--------|
| 模型 | XDEV_MODEL | glm-5 |
| 艾克斯目录 | XDEV_HOME | ~/.xdev |
| HTTP 端口 | XDEV_PORT | 8081 |
| API Token | XDEV_API_TOKEN | null |

### 5.3 目录结构

```
~/.xdev/
├── workspace/           # 工作目录（Claude 会话）
├── workers/             # Worker 元数据
├── experts/             # 专家配置
│   ├── coder/CLAUDE.md
│   ├── analyst/CLAUDE.md
│   ├── operator/CLAUDE.md
│   └── researcher/CLAUDE.md
├── locks/               # 文件锁
├── xdev.db           # SQLite 数据库
└── system-prompt.md     # 自定义系统提示词
```

---

## 6. 部署方案

### 6.1 Systemd 服务

```bash
# 安装
sudo ./install-xdev.sh

# 服务管理
systemctl --user start xdev
systemctl --user stop xdev
systemctl --user restart xdev
systemctl --user status xdev

# 查看日志
journalctl --user -u xdev -f
```

### 6.2 HTTP API 调用

```bash
# 调用专家
curl -X POST http://localhost:8081/api/experts/coder/call \
  -H "Content-Type: application/json" \
  -d '{"task": "重构登录模块"}'

# 查看专家列表
curl http://localhost:8081/api/experts

# 查看队列状态
curl http://localhost:8081/api/experts/queue
```

---

## 7. 架构亮点

1. **消息队列机制**: 防止消息丢失，保证顺序处理
2. **专家系统**: 任务自动分配，专家间协作
3. **安全验证**: 路径验证、任务验证、递归检测
4. **高可用设计**: 自动重连、优雅关闭、状态持久化
5. **统一配置**: 集中管理，优先级清晰
6. **FTS5 全文搜索**（v3.1 新增）: 快速检索历史会话
7. **记忆压缩系统**（v3.1 新增）: 自动提取和注入长期记忆
8. **生命周期钩子**（v3.1 新增）: 可扩展的事件驱动架构

---

## 8. v3.1 更新日志

### 新增功能

1. **FTS5 全文搜索**
   - 对专家会话建立全文索引
   - 支持关键词搜索和专家名过滤
   - 自动同步触发器

2. **记忆压缩系统**
   - 自动提取用户偏好、重要决策、未完成任务
   - 会话压缩时注入长期记忆到系统提示词
   - 支持记忆重要级排序和过期清理

3. **生命周期钩子**
   - 5 种钩子类型：session_start, user_prompt, post_tool, session_end, expert_complete
   - 支持 URL 处理器注册
   - 并行执行多个处理器

### 代码量统计

| 功能 | 新增代码 | 修改文件 |
|------|----------|----------|
| FTS5 全文搜索 | ~60 行 | sqlite.ts |
| 记忆压缩 | ~150 行 | sqlite.ts, claude-native-agent.ts |
| 生命周期钩子 | ~100 行 | hooks-receiver.ts |
| **总计** | **~310 行** | 3 个文件 |

---

**文档版本**: v3.1
**更新日期**: 2026-03-01
