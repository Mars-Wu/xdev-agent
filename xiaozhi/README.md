# 小智 (Xiaozhi) - AI 管家

基于 [智谱 GLM API](https://open.bigmodel.cn)（Claude 兼容端点）的自主 AI 管家，以 systemd 用户服务方式运行，主要通过飞书（Lark）接收和回复消息。

---

## 架构概览

```
飞书消息输入
     │
Stage 0: 去重 / 长度校验
     │
Stage 1: 话题路由器 (glm-4.7-flash)
     │   message-router.ts — 判断话题归属，选取历史策略，分拆多话题子问题
     │
Stage 1.5: Context 组装
     │   按路由结果从话题 history bucket 加载适量上下文 + 相关记忆
     │
Stage 2: Agent Loop (glm-5-turbo)
     │   agent-loop.ts — while(tool_use) 循环，支持 20+ 工具调用，最大 30 轮
     │
Stage 2.5: 回复选择器 (glm-4.7-flash) [多候选时启用]
     │   selectBestResponse — 选出最符合原始问题的段落
     │
Stage 3: 合并回复 → 发送飞书
     │
Background Pass (异步, glm-4.7-flash)
     └─ background-memory.ts — 提取实体标签、话题关系、episodic pattern，写入记忆
```

---

## 多 LLM 流水线

| 阶段 | 模型（默认） | 作用 |
|------|-------------|------|
| Stage 1 路由 | `glm-4.7-flash` | 话题分类，单次 JSON 输出 |
| Stage 2 主 Agent | `glm-5-turbo` | 工具调用 + 长链路推理 |
| Stage 2.5 选择器 | `glm-4.7-flash` | 多候选回复排序 |
| Background Pass | `glm-4.7-flash` | 异步记忆提取与摘要更新 |

---

## 核心模块

| 目录 | 描述 |
|------|------|
| `src/core/` | LLM 客户端、Agent Loop、消息路由器、后台记忆 Pass |
| `src/feishu/` | 飞书客户端（WebSocket 长连接 + 消息收发） |
| `src/api/` | HTTP 接口（HooksReceiver，默认端口 8081） |
| `src/gateway/` | WebSocket 控制平面（默认端口 18789） |
| `src/memory/` | 记忆系统（SQLite 持久化，重要度排序） |
| `src/storage/` | 话题图（TopicGraph）、SQLite 存储 |
| `src/tools/` | 工具注册表及所有内置工具 |
| `src/skills/` | 技能注册表（markdown 格式，运行时加载） |
| `src/prompt/` | System prompt 构建器（注入记忆 + 技能菜单） |
| `src/plugin-sdk/` | 事件总线（EventBus）、插件管理器 |
| `src/context/` | 上下文压缩（micro-compact） |
| `src/browser/` | Playwright 浏览器适配 |
| `src/config/` | 配置管理（`~/.xiaozhi/config.json` + 环境变量） |
| `src/monitor/` | 内存使用监控 |

---

## 工具列表

Agent Loop 可调用以下工具：

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令 |
| `read` / `write` / `edit` / `list` | 文件读写 |
| `glob` | 文件路径模式匹配 |
| `grep` | 代码内容搜索 |
| `web_search` | 网络搜索 |
| `web_fetch` | 抓取网页内容 |
| `browser_adapter` | Playwright 浏览器操作 |
| `agent` | 启动子 Agent 执行独立任务 |
| `schedule` | 创建定时/延迟任务 |
| `use_skill` / `list_skills` | 按需加载技能 |
| `todo` / `start_todo` / `complete_todo` | 轻量 Todo 追踪 |
| `create_task` / `ready_tasks` | 持久化 DAG 任务系统 |
| `background` / `notification` | 后台异步任务 |
| `worktree` / `enter_worktree` / `exit_worktree` | Git Worktree 隔离工作区 |

---

## 配置

复制 `.env.example` 为 `.env`，填入以下环境变量：

### 必填

| 变量 | 说明 |
|------|------|
| `ZHIPU_API_KEY` | 智谱 API Key（或 `ANTHROPIC_AUTH_TOKEN`） |
| `FEISHU_APP_ID` | 飞书应用 ID（以 `cli_` 开头） |
| `FEISHU_APP_SECRET` | 飞书应用密钥 |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ZHIPU_API_BASE_URL` | `https://open.bigmodel.cn/api/anthropic` | API 基础地址 |
| `XIAOZHI_MODEL` | `glm-5-turbo` | Stage 2 主 Agent 模型 |
| `XIAOZHI_ROUTER_MODEL` | `glm-4.7-flash` | Stage 1 路由器模型 |
| `XIAOZHI_SELECTOR_MODEL` | `glm-4.7-flash` | Stage 2.5 选择器模型 |
| `XIAOZHI_BACKGROUND_MODEL` | `glm-4.7-flash` | Background Pass 模型 |
| `XIAOZHI_MAX_TURNS` | `30` | Agent Loop 最大轮次 |
| `XIAOZHI_GATEWAY_PORT` | `18789` | WebSocket 控制平面端口 |
| `XIAOZHI_HOOKS_PORT` | `8081` | HTTP API 端口 |
| `XIAOZHI_MAX_MESSAGE_LENGTH` | `100000` | 消息长度上限（字符） |
| `XIAOZHI_LOG_LEVEL` | `info` | 日志级别（debug/info/warn/error） |

配置文件可放置于 `~/.xiaozhi/config.json`，优先级：环境变量 > 配置文件 > 默认值。

---

## HTTP API

默认端口 `8081`（`XIAOZHI_HOOKS_PORT`）。带 🔒 的端点需要 `Authorization: Bearer <token>` 请求头。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/health/detailed` 🔒 | 详细健康信息 |
| GET | `/api/models` | 可用模型列表 |
| GET | `/api/models/:id` | 模型详情 |
| GET | `/api/sessions/stats` | 会话统计 |
| POST | `/api/sessions/clear` 🔒 | 清空会话 |
| POST | `/api/chat` 🔒 | 直接对话 |
| POST | `/api/hooks/trigger` 🔒 | 触发钩子事件 |
| GET | `/api/hooks` | 查看已注册钩子 |
| POST | `/api/hooks/:type/register` 🔒 | 注册钩子处理器 |
| POST | `/test/message` 🔒 | 发送测试消息 |
| GET | `/api-docs.json` | Swagger API 文档 |

---

## WebSocket 控制平面 (Gateway)

默认端口 `18789`（`XIAOZHI_GATEWAY_PORT`）。使用 JSON-RPC 风格协议。

| 方法 | 说明 |
|------|------|
| `ping` | 健康检查（返回 pong + timestamp） |
| `status` | Gateway 运行状态 |
| `session.list` | 会话列表 |
| `config.get` | 获取系统配置（隐藏敏感字段） |
| `plugin.list` | 已加载插件列表 |
| `channel.status` | 通道连接状态 |
| `chat` | 直接与小智对话 |

---

## 构建与测试

```bash
# 在 xiaozhi/ 目录下执行
npm run build        # tsc 编译 + 复制内置技能到 dist/skills/
npm run dev          # 直接用 ts-node 运行（无需编译）
npm run watch        # 增量 tsc 监听

npm test             # vitest 运行所有 *.test.ts
npm run test:watch   # vitest 监听模式
npm run test:coverage # v8 覆盖率报告

# 运行单个测试文件
npx vitest run src/memory/memory-manager.test.ts
```

---

## 服务管理

小智以 systemd 用户服务运行：

```bash
systemctl --user restart xiaozhi    # 重启服务
systemctl --user stop xiaozhi       # 停止服务
systemctl --user status xiaozhi     # 查看状态
journalctl --user -u xiaozhi -f     # 实时日志
```

---

## 数据目录

所有运行时数据存储于 `~/.xiaozhi/`：

| 路径 | 内容 |
|------|------|
| `~/.xiaozhi/xiaozhi.db` | SQLite 主数据库（话题图、任务等） |
| `~/.xiaozhi/memory/` | 长期记忆文件 |
| `~/.xiaozhi/workspace/` | Agent 自主任务工作目录 |
| `~/.xiaozhi/sessions/` | 历史会话归档 |
| `~/.xiaozhi/logs/` | 日志文件 |
| `~/.xiaozhi/config.json` | 自定义配置（可选） |
| `~/.xiaozhi/system-prompt.md` | 自定义系统提示词（可选） |
