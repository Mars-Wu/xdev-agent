# xdev_agent

`xdev_agent` 是 **艾克斯（xdev）** 的开源仓库：一个面向 **飞书** 的 AI 管家 / 工程助手，使用 **智谱 GLM 的 Anthropic 兼容接口**，支持 **长期运行、任务执行、工作流、可观测导出**，并以 **Linux + systemd** 为首选部署方式。

主应用代码位于 **`xdev/`** 目录。

## 这个仓库适合做什么

- 在飞书里部署一个可长期运行的 AI 助手
- 让助手围绕本地代码库做分析、执行、回顾与运维
- 用 workflow / task DAG / background jobs 组织复杂任务
- 导出 topic graph、task graph、memory report、codebase map 做排障和观察

## 主要优势

- **Feishu-first**：默认使用飞书长连接接收事件，不依赖公网回调地址
- **systemd-first**：安装、升级、常驻运行路径清晰
- **工程执行能力**：内置 workflow runtime、task DAG、后台任务、map 工具
- **持续上下文能力**：支持话题路由、历史聚合、记忆提取、多轮续问
- **运维友好**：内置 `doctor`、`smoke-check`、`export-status`
- **测试分层**：包含本地测试、集成测试、live Feishu 执行层

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `xdev/` | 主应用目录，包含源码、CLI、部署脚本、测试与应用文档 |
| `docs/` | 项目分析、设计、迁移与补充说明文档 |
| `openclaw-analysis/` | 历史分析与对比资料 |

## 快速开始

```bash
git clone git@github.com:wuxiaoyu19900108/xdev_agent.git
cd xdev_agent/xdev
sudo ./install-xdev.sh
```

安装后继续：

```bash
sudo editor /etc/xdev/environment
sudo systemctl start xdev
sudo xdev doctor --env-file /etc/xdev/environment
```

## 从哪里开始看

- 项目首页与完整说明：[`xdev/README.md`](xdev/README.md)
- 部署与排障：[`xdev/docs/GUIDE.md`](xdev/docs/GUIDE.md)
- 飞书 live 回归：[`xdev/docs/FEISHU_E2E_TEST_CASES.md`](xdev/docs/FEISHU_E2E_TEST_CASES.md)
- 本地开发配置示例：[`xdev/.env.example`](xdev/.env.example)

## 开发与测试

```bash
cd xdev
npm install
npm run build
npm test
npm run test:integration
```

如果要跑 live Feishu 用例：

```bash
cd xdev
CHAT_ID=<chat_id> npm run test:live:feishu -- --focus unfinished
```

## 当前部署约定

- systemd 系统服务代码目录：`/opt/xdev`
- systemd 数据目录：`/var/lib/xdev`
- systemd 环境文件：`/etc/xdev/environment`
- 本地源码运行默认数据目录：`~/.xdev`

当前项目默认使用 **`~/.xdev`**，不再使用 `~/.xiaozhi`。
