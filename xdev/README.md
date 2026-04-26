# xdev

xdev is a Feishu-first AI assistant for long-running engineering and operations work. It accepts messages from Feishu, executes tools against local resources, manages workflows and task graphs, and exports runtime state for debugging and review.

The service is built around the Zhipu GLM API through an Anthropic-compatible endpoint and is packaged primarily for Linux + `systemd` deployments.

## Core capabilities

| Area | What xdev provides |
| --- | --- |
| Messaging | Feishu WebSocket event intake, replies, and multi-turn conversations |
| Agent runtime | Tool calls, staged workflows, task DAGs, and background jobs |
| Context management | Topic routing, history aggregation, summaries, and memory extraction |
| Observability | Codebase maps, topic graphs, task graphs, and memory reports |
| Operations | `doctor`, `smoke-check`, `export-status`, and service-friendly deployment paths |
| Testing | Local tests, integration tests, and live Feishu regression flows |

## Architecture at a glance

```text
Feishu / CLI
    ↓
Gateway and hooks receiver
    ↓
LLM client
    ↓
Agent loop + tools + skills
    ↓
Workflow / task / background systems
    ↓
SQLite state + export artifacts
```

## Typical use cases

- Run an assistant inside Feishu group chats or direct messages
- Analyze or operate on a local codebase instead of only generating text replies
- Keep a long-running assistant recoverable through exported state and service tooling
- Attach structured Feishu tools through `lark-cli` for documents, messaging, calendars, and more

## Requirements

- Linux with `systemd` recommended
- Node.js 18+
- npm 9+
- Zhipu API key
- A Feishu custom app with bot and event permissions

## Recommended installation: system service

```bash
git clone git@github.com:wuxiaoyu19900108/xdev_agent.git
cd xdev_agent/xdev
sudo ./install-xdev.sh
sudo editor /etc/xdev/environment
sudo systemctl start xdev
sudo systemctl status xdev
```

The installer prepares:

- system user `xdev`
- code under `/opt/xdev`
- data under `/var/lib/xdev`
- environment file `/etc/xdev/environment`
- `xdev.service`
- CLI entrypoint `/usr/local/bin/xdev`

### Minimum required environment

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Common optional settings:

```bash
GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
FEISHU_USE_WEBSOCKET=true
XDEV_HOME=/var/lib/xdev
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_LOG_LEVEL=info
```

After startup, verify the service:

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
curl http://127.0.0.1:8081/health
sudo journalctl -u xdev -f
```

## Run from source

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

Local source runs use `~/.xdev` by default. Override it with `XDEV_HOME=/your/path` if needed.

## Common commands

### Build and test

```bash
npm run build
npm test
npm run test:integration
npm run test:coverage
```

Live Feishu regression:

```bash
CHAT_ID=<chat_id> npm run test:live:feishu -- --list
CHAT_ID=<chat_id> npm run test:live:feishu -- --focus unfinished
CHAT_ID=<chat_id> npm run test:live:feishu -- --case IM-006,IM-010
```

### Service management

```bash
sudo systemctl start xdev
sudo systemctl stop xdev
sudo systemctl restart xdev
sudo systemctl status xdev
sudo journalctl -u xdev -f
```

### Operational tools

```bash
xdev doctor
xdev smoke-check
xdev export-status
```

With a system installation, prefer passing the environment file explicitly:

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
sudo xdev export-status
```

## Runtime paths

| Mode | Code directory | Data directory | Environment file |
| --- | --- | --- | --- |
| system service | `/opt/xdev` | `/var/lib/xdev` | `/etc/xdev/environment` |
| local source run | repository checkout | `~/.xdev` | repository `.env` |

## Exported artifacts

`xdev export-status` typically writes:

- `XDEV_HOME/cache/codebase-maps/`
- `XDEV_HOME/cache/observability/topic-report.md`
- `XDEV_HOME/cache/observability/topic-graph.json`
- `XDEV_HOME/cache/observability/task-report.md`
- `XDEV_HOME/cache/observability/task-graph.json`
- `XDEV_HOME/cache/observability/memory-report.md`
- `XDEV_HOME/cache/observability/memory-report.json`

These files are useful for diagnosing routing, memory, and task execution behavior.

## Related documents

| File | Purpose |
| --- | --- |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Deployment, troubleshooting, and upgrade notes |
| [`docs/FEISHU_E2E_TEST_CASES.md`](docs/FEISHU_E2E_TEST_CASES.md) | Live Feishu validation scenarios |
| [`../docs/feishu-cli-guide.md`](../docs/feishu-cli-guide.md) | `lark-cli` usage notes for Feishu integration |
| [`../docs/xdev-capability-list.md`](../docs/xdev-capability-list.md) | Public capability inventory |
| [`.env.example`](.env.example) | Local development environment sample |

For a local long-running `systemd --user` service, prefer an external environment file such as `~/.config/xdev/environment` instead of keeping secrets in the repository checkout.

## Boundaries and current focus

- Linux + `systemd` + Feishu is the primary supported deployment model
- Image and file flows depend on correct Feishu resource scopes
- Live Feishu tests still benefit from manual verification around media handling
- For local development only, source mode is fine; for durable service behavior, use the installer

## License

[MIT](../LICENSE) © 2025 wxy
