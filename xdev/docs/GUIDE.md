# 艾克斯部署指南

本文档面向开源用户，提供一条**以 systemd 系统服务为主**的安装、飞书接入、调试与排障路径。

## 1. 部署模式

推荐顺序：

1. **systemd 系统服务**：生产 / 常驻运行
2. **源码运行**：开发 / 调试

默认约定：

| 模式 | 代码目录 | 数据目录 | 环境变量文件 |
| --- | --- | --- | --- |
| systemd 系统服务 | `/opt/xdev` | `/var/lib/xdev` | `/etc/xdev/environment` |
| 源码运行 | 仓库目录 | `~/.xdev` | 仓库内 `.env` |

## 2. 前置条件

- Linux（带 systemd）
- Node.js 18+
- npm 9+
- 智谱 API Key
- 飞书自建应用

## 3. 飞书应用配置

在飞书开放平台创建**自建应用**后，至少完成以下配置：

### 3.1 基础能力

1. 启用**机器人**
2. 启用**长连接接收事件**
3. 订阅事件 **`im.message.receive_v1`**

### 3.2 权限建议

至少保证应用具备这些能力对应的权限：

- 接收机器人消息事件
- 发送消息 / 回复消息
- 访问图片、文件等消息资源

如果后续要让 Agent 主动操作更多飞书对象，再按需补日历、文档、表格等权限。

## 4. systemd 系统服务安装（推荐）

### 4.1 一键安装

```bash
git clone <repo-url>
cd xdev
sudo ./install-xdev.sh
```

### 4.2 填写配置

编辑 `/etc/xdev/environment`：

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/anthropic

FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_USE_WEBSOCKET=true

XDEV_HOME=/var/lib/xdev
XDEV_DB=/var/lib/xdev/data/xdev.db
XDEV_GATEWAY_HOST=127.0.0.1
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_MODEL=glm-5-turbo
XDEV_ROUTER_MODEL=glm-4.7-flash
XDEV_SELECTOR_MODEL=glm-4.7-flash
XDEV_BACKGROUND_MODEL=glm-4.7-flash
XDEV_TIMEOUT=120000
XDEV_MAX_RETRIES=3
XDEV_RETRY_DELAY=1000
XDEV_LOG_LEVEL=info
```

### 4.3 启动与验证

```bash
sudo systemctl daemon-reload
sudo systemctl enable xdev
sudo systemctl start xdev
sudo systemctl status xdev
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
curl http://127.0.0.1:8081/health
```

看实时日志：

```bash
sudo journalctl -u xdev -f
```

## 5. 源码运行（开发调试）

```bash
git clone <repo-url>
cd xdev
npm install
cp .env.example .env
editor .env
npm run build
npm test
npm run dev
```

源码运行默认使用 `~/.xdev`；如果需要改位置，设置 `XDEV_HOME=/your/path`。

## 6. 构建与升级

### 6.1 干净构建

```bash
npm run build
```

当前构建脚本会自动先清空 `dist/`，避免旧的编译产物污染新版本。

### 6.2 升级 systemd 安装

```bash
git pull
sudo ./install-xdev.sh
sudo systemctl restart xdev
```

安装脚本会先清空旧的 `/opt/xdev` 再复制新构建，避免孤儿文件残留。

## 6.3 状态导出

```bash
sudo xdev export-status
```

默认导出位置：

- `/var/lib/xdev/cache/codebase-maps/`
- `/var/lib/xdev/cache/observability/topic-report.md`
- `/var/lib/xdev/cache/observability/topic-graph.json`
- `/var/lib/xdev/cache/observability/task-report.md`
- `/var/lib/xdev/cache/observability/task-graph.json`
- `/var/lib/xdev/cache/observability/memory-report.md`
- `/var/lib/xdev/cache/observability/memory-report.json`

## 7. 可选：配置 lark-cli 做联调

`lark-cli` 不是运行艾克斯的必需项，但很适合验证飞书消息链路。

### 7.1 安装与登录

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login
```

### 7.2 给机器人发消息

```bash
lark-cli im +messages-send --as user --chat-id <chat_id> --text "你好，艾克斯"
```

如果按名字搜索不到 P2P 会话：

1. 先在飞书客户端给机器人发一条消息
2. 用 `lark-cli im +messages-search --as user --query "你好，艾克斯"` 反查 `chat_id`
3. 再使用 `+messages-send`

## 8. 常见问题

### 8.1 服务启动失败

优先检查：

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo systemctl status xdev --no-pager
sudo journalctl -u xdev -n 100 --no-pager
```

常见原因：

- `/etc/xdev/environment` 缺少 `ZHIPU_API_KEY`
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 不正确
- 飞书应用未启用长连接
- 未订阅 `im.message.receive_v1`

### 8.2 健康检查正常，但飞书收不到消息

重点检查：

1. 机器人是否已发布到可用版本
2. 长连接接收事件是否启用
3. 事件订阅是否包含 `im.message.receive_v1`
4. 当前给机器人发消息的用户是否在应用可见范围内

### 8.3 能收消息但不能处理图片 / 文件

说明应用大概率缺少图片 / 文件资源访问相关权限，或者消息资源下载受限。

### 8.4 想改数据目录

直接修改：

```bash
XDEV_HOME=/your/path
XDEV_DB=/your/path/xdev.db
```

如果是 systemd 系统服务，改完 `/etc/xdev/environment` 后执行：

```bash
sudo systemctl restart xdev
```

## 9. 相关文件

| 文件 | 用途 |
| --- | --- |
| `install-xdev.sh` | systemd 系统服务安装脚本 |
| `xdev.service` | systemd unit |
| `.env.example` | 本地源码运行示例配置 |
| `README.md` | 项目首页说明 |
