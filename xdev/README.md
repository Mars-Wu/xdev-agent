# 艾克斯（xdev）

一个面向 **飞书** 的 AI 管家 / 工程助手，使用 **智谱 GLM 的 Anthropic 兼容接口**，以 **systemd 系统服务** 为首选部署方式。

它不是只会聊天的机器人。xdev 更偏向“可长期运行的工程型助手”：

- 可以在飞书中接收消息、持续对话、处理多轮上下文
- 可以调用本地工具、执行阶段化 workflow、管理 task DAG 与后台任务
- 可以生成项目 `map`、导出 topic / task / memory 可观测产物
- 自带 `doctor`、`smoke-check`、`export-status`，适合开源分发和长期运维

## 适合什么场景

- 把 AI 助手接到飞书群聊或私聊里，做内部问答、运维助手、项目助手
- 让助手围绕本地代码库做分析、执行、回顾，而不是只生成一次性回答
- 为长期运行的 Agent 提供更稳定的状态管理、记忆、排障和导出能力

## 核心特点

| 特点 | 说明 |
| --- | --- |
| **Feishu-first** | 默认使用飞书长连接接收事件，不依赖公网回调地址 |
| **systemd-first** | 优先面向 Linux + systemd 部署，安装、升级、常驻运行路径清晰 |
| **工程工作流** | 内置 workflow runtime，支持 stage、pass criteria、checkpoint、pivot、resume |
| **任务执行能力** | 内置 task DAG、后台任务、通知与阶段联动，不只是单轮工具调用 |
| **项目理解能力** | 内置 `map` 工具，能生成代码库快照和结构化项目摘要 |
| **持续上下文** | 有话题路由、历史聚合、记忆提取、多轮续问承接 |
| **可观测性** | 可导出 topic graph、task graph、memory report、codebase map |
| **运维入口完整** | 提供 `doctor`、`smoke-check`、`export-status` |
| **测试分层** | 同时有本地测试、集成测试和 live Feishu 执行层 |

## 相比普通聊天机器人的优势

1. **更会执行**：不是只返回文本，还能把复杂任务拆成阶段、任务和后台执行流。
2. **更能持续工作**：有 workflow 恢复、任务图、topic graph、记忆系统，不容易“一轮对话结束就失忆”。
3. **更容易排障**：能导出结构化状态，自检入口完整，适合常驻服务。
4. **更适合开源交付**：systemd 安装脚本、运行目录、环境变量、升级路径都已经工程化。

## 架构概览

```text
Feishu / CLI
    ↓
Gateway / Hooks Receiver
    ↓
LLM Client (GLM Claude-compatible API)
    ↓
Agent Loop + Tool Registry + Skill Registry
    ↓
Workflow / Task / Background Jobs / Map / Lark Tools
    ↓
SQLite + Topic Graph + Memory + Export Artifacts
```

当前实现重点在：

- **飞书消息入口**
- **本地工具执行**
- **项目快照与可观测导出**
- **长期运行的工作流 / 任务 / 记忆体系**

## 快速开始

### 1. 前置条件

- Linux（推荐使用 systemd 的发行版）
- Node.js 18+
- npm 9+
- 智谱 API Key
- 一个飞书自建应用

### 2. 飞书应用至少要完成这些配置

1. 启用 **机器人能力**
2. 启用 **长连接接收事件**
3. 订阅事件 **`im.message.receive_v1`**
4. 赋予消息接收、消息发送，以及图片 / 文件消息资源相关权限

> xdev 默认走飞书长连接，所以通常不需要公网回调地址。

## 推荐安装方式：systemd 系统服务

```bash
git clone git@github.com:wuxiaoyu19900108/xdev_agent.git
cd xdev_agent/xdev
sudo ./install-xdev.sh
sudo editor /etc/xdev/environment
sudo systemctl start xdev
sudo systemctl status xdev
```

安装脚本会自动：

- 创建系统用户 `xdev`
- 把应用安装到 `/opt/xdev`
- 创建数据目录 `/var/lib/xdev`
- 写入 `/etc/xdev/environment`
- 安装 `xdev.service`
- 安装 CLI 命令 `/usr/local/bin/xdev`

### 最小必填配置

编辑 `/etc/xdev/environment`，至少填写：

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

常见可选项：

```bash
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/anthropic
FEISHU_USE_WEBSOCKET=true
XDEV_HOME=/var/lib/xdev
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_LOG_LEVEL=info
```

### 启动后建议立刻执行

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
curl http://127.0.0.1:8081/health
sudo journalctl -u xdev -f
```

## 源码运行（开发 / 调试）

```bash
git clone git@github.com:wuxiaoyu19900108/xdev_agent.git
cd xdev_agent/xdev
npm install
cp .env.example .env
editor .env
npm run build
npm test
npm run dev
```

源码运行默认使用 `~/.xdev`。如果需要改数据目录，设置：

```bash
XDEV_HOME=/your/path
```

## 常用命令

### 构建与测试

```bash
npm run build
npm test
npm run test:integration
npm run test:coverage
```

live Feishu 回归：

```bash
CHAT_ID=<chat_id> npm run test:live:feishu -- --list
CHAT_ID=<chat_id> npm run test:live:feishu -- --focus unfinished
CHAT_ID=<chat_id> npm run test:live:feishu -- --case IM-006,IM-010
```

### 服务管理

```bash
sudo systemctl start xdev
sudo systemctl stop xdev
sudo systemctl restart xdev
sudo systemctl status xdev
sudo journalctl -u xdev -f
```

### 运维与导出

```bash
xdev doctor
xdev smoke-check
xdev export-status
```

如果是 systemd 安装，通常建议显式传入环境文件：

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
sudo xdev export-status
```

## 运行目录约定

| 场景 | 代码目录 | 数据目录 | 环境文件 |
| --- | --- | --- | --- |
| systemd 系统服务 | `/opt/xdev` | `/var/lib/xdev` | `/etc/xdev/environment` |
| 本地源码运行 | 仓库目录 | `~/.xdev` | 仓库内 `.env` |

`XDEV_HOME` 是运行时根目录。当前项目默认使用 **`~/.xdev`**，不再使用 `~/.xiaozhi`。

## 导出产物

`xdev export-status` 默认会生成这些可观测产物：

- `XDEV_HOME/cache/codebase-maps/`
- `XDEV_HOME/cache/observability/topic-report.md`
- `XDEV_HOME/cache/observability/topic-graph.json`
- `XDEV_HOME/cache/observability/task-report.md`
- `XDEV_HOME/cache/observability/task-graph.json`
- `XDEV_HOME/cache/observability/memory-report.md`
- `XDEV_HOME/cache/observability/memory-report.json`

这些文件用于：

- 排查 topic routing / memory / task 阻塞问题
- 理解当前项目快照
- 观察 Agent 执行后留下的结构化状态

## 配置说明

完整示例见：

- `.env.example`
- `docs/GUIDE.md`

当前支持这些兼容变量别名：

- API Key：`ZHIPU_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`
- API Base URL：`ZHIPU_API_BASE_URL` 或 `GLM_BASE_URL` 或 `ANTHROPIC_BASE_URL`

## 可选：用 lark-cli 联调飞书链路

`lark-cli` 不是运行 xdev 的必需依赖，但很适合做 live 联调和回归测试。

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login
lark-cli im +messages-send --as user --chat-id <chat_id> --text "你好，艾克斯"
```

如果你想把 README 之外的联调流程写得更细，可以继续看：

- `docs/FEISHU_E2E_TEST_CASES.md`
- `../docs/飞书CLI使用说明.md`

## 当前边界与注意事项

- **优先支持 Linux + systemd + 飞书**；其他部署模型不是当前主路径
- 图片 / 文件消息链路依赖飞书资源权限，接入时要额外确认 scope
- live Feishu 测试里，图片与文件相关用例通常需要手动补充验证
- 如果你只想做本地开发，源码运行即可；如果要长期运行，优先用 systemd 安装

## 相关文档

| 文件 | 用途 |
| --- | --- |
| `docs/GUIDE.md` | 部署、排障、升级指南 |
| `docs/FEISHU_E2E_TEST_CASES.md` | 飞书 live 回归用例与执行方式 |
| `.env.example` | 本地开发环境变量示例 |
| `install-xdev.sh` | systemd 系统服务安装脚本 |
| `xdev.service` | systemd unit 文件 |

## License

[MIT](../LICENSE) © 2025 wxy
