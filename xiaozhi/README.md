# 小智 (Xiaozhi) - AI 管家系统

基于 Claude CLI 的智能管家系统，通过飞书提供对话接口，拥有 AI 专家团队处理特定类型任务，支持自我升级、定时任务和 Harness 工程最佳实践。

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
│  │   POST /api/experts/:name/call - 调用专家                │   │
│  │   POST /api/callbacks/complete - 专家完成回调            │   │
│  │   GET  /api/experts           - 专家列表                 │   │
│  │   GET  /api/cron/tasks        - 定时任务列表             │   │
│  │   POST /api/cron/tasks        - 创建定时任务             │   │
│  │   POST /upgrade/start         - 开始升级                 │   │
│  │   POST /upgrade/test          - 测试影子实例             │   │
│  │   POST /upgrade/execute       - 执行升级                 │   │
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
│   │   ├── manager.ts               # 专家管理器
│   │   ├── executor.ts              # 专家执行器
│   │   ├── session-manager.ts       # 会话管理
│   │   ├── progress-tracker.ts      # 进度追踪 (Harness)
│   │   └── feature-list.ts          # 功能清单 (Harness)
│   ├── file/                        # 文件处理模块
│   │   ├── manager.ts               # 文件管理器（下载、存储）
│   │   └── analyzer.ts              # 文件分析器（PDF/Word/Excel/图片）
│   ├── cron/
│   │   ├── manager.ts               # 定时任务管理器
│   │   └── types.ts                 # 类型定义
│   ├── feishu/
│   │   ├── client.ts                # 飞书客户端
│   │   ├── types.ts                 # 类型定义
│   │   ├── card-builder.ts          # 富卡片构建器
│   │   └── card-types.ts            # 卡片类型定义
│   ├── upgrade/                     # 自我升级系统
│   │   ├── types.ts                 # 类型定义
│   │   ├── recorder.ts              # 升级记录
│   │   ├── shadow.ts                # 影子实例
│   │   ├── tester.ts                # 测试消息
│   │   └── manager.ts               # 升级管理器
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
├── upgrades/                        # 升级记录
│   └── 2026-02-25_001/
│       ├── state.json               # 升级状态
│       └── execute.sh               # 执行脚本
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

### 任务结构

```typescript
interface CronTask {
  id: string;
  description: string;     // 自然语言描述
  cronExpr: string;        // cron 表达式 "0 6 * * *"
  taskContent: string;     // 要执行的任务内容
  chatId: string;          // 关联的飞书聊天 ID
  enabled: boolean;
  silent: boolean;         // 静默模式
}
```

## Harness 工程特性

基于 OpenAI 和 Anthropic 的 Harness 工程最佳实践，提升长时运行 Agent 的可靠性。

### 进度追踪 (Progress Tracker)

在每个工作目录维护 `.xiaozhi-progress.md` 文件，让新 Agent 能快速了解历史工作：

- 记录每个任务的状态（开始/进行中/完成/失败）
- 生成文件和下一步建议
- 人类可读的 Markdown 格式

### 功能清单 (Feature List)

使用 `.xiaozhi-features.json` 定义"什么算完成"，防止 Agent 提前宣布任务完成：

- 结构化的功能列表
- 验证步骤和预期结果
- 依赖关系管理

## HTTP API

| 路由 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/queue` | GET | 队列状态 |
| `/api/experts` | GET | 专家列表 |
| `/api/experts/:name` | GET | 专家详情 |
| `/api/experts/:name/call` | POST | 调用专家 |
| `/api/experts/:name/sessions` | GET | 专家会话历史 |
| `/api/callbacks/complete` | POST | 专家完成回调 |
| `/api/sessions/:id` | GET | 会话状态 |
| `/api/sessions/:id/stop` | POST | 停止会话 |
| `/api/cron/tasks` | GET/POST | 定时任务管理 |
| `/api/cron/tasks/:id` | DELETE | 删除定时任务 |

## 技术特点

1. **专家系统** - 不同专家处理不同类型任务，支持会话策略（--continue）
2. **统一架构** - 小智和专家都用 `claude --print`
3. **消息队列** - 飞书和专家消息排队处理
4. **并行处理** - 小智不等待专家，专家完成后回调
5. **自我升级** - 安全升级，测试通过才执行
6. **tmux 守护** - 升级过程独立于服务进程
7. **定时任务** - 支持 cron 表达式的定时任务管理
8. **进度追踪** - Harness 工程最佳实践，跨会话状态追踪
9. **内存监控** - 自动监控内存使用，超阈值告警
10. **文件处理** - 支持飞书文件接收、智能分析和自然语言管理

## 文件处理功能

用户可以通过飞书发送文件给小智，小智会自动下载、分析并存储。

### 支持的文件类型

| 类型 | 扩展名 | 处理方式 |
|------|--------|----------|
| PDF | .pdf | 提取文本内容 |
| Word | .doc, .docx | 提取文本内容 |
| Excel | .xls, .xlsx | 解析表格数据 |
| 图片 | .png, .jpg, .gif, .webp | Claude Vision 多模态分析 |

### 文件管理

用户可以用自然语言管理文件：
- "有什么文件" → 列出所有存储的文件
- "删除那个 xxx 文档" → 删除指定文件
- "清理一下旧文件" → 清理过期文件

### 技术实现

- **FileManager** (`src/file/manager.ts`): 文件下载、存储、元数据管理
- **FileAnalyzer** (`src/file/analyzer.ts`): 多格式文件解析
  - PDF: pdf-parse
  - Word: mammoth
  - Excel: xlsx (SheetJS)
  - 图片: Claude Vision

### 存储位置

- 文件: `~/.xiaozhi/files/`
- 元数据: SQLite `files` 表

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
- node-cron（定时任务）

## 许可证

MIT
