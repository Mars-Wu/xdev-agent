# xdev

xdev is a Feishu-first AI assistant for long-running engineering and operations work. It accepts messages from Feishu, executes tools against local resources, manages workflows and task graphs, and exports runtime state for debugging and review.

The service uses an Anthropic-compatible text LLM interface and can now switch between **GLM** and **DeepSeek** for text models through configuration. Vision analysis remains on the GLM visual endpoint and is configured separately. The service is packaged primarily for Linux + `systemd` deployments.

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
- One text provider API key: **GLM** or **DeepSeek**
- A Feishu custom app with bot and event permissions
- `lark-cli` recommended for Feishu-side setup and live testing

## Fastest setup path for new users

If you want to get to a working Feishu bot quickly, do these in order:

1. **Create a Feishu custom app**
   - enable **Bot**
   - enable **WebSocket event delivery**
   - subscribe to `im.message.receive_v1`
   - grant the IM scopes needed for message receive/send and any media flows you want
2. **Install `lark-cli`**
   ```bash
   npm install -g @larksuite/cli
   lark-cli config init --new
   lark-cli auth login
   lark-cli auth status --verify
   ```
3. **Install xdev**
   ```bash
   git clone git@github.com:Mars-Wu/xdev-agent.git
   cd xdev-agent/xdev
   sudo ./install-xdev.sh
   ```
4. **Pick a text model provider**
   - **GLM** for the current default path
   - **DeepSeek** if you want the DeepSeek text stack
5. **Fill `/etc/xdev/environment`**
6. **Start and verify**
   ```bash
   sudo systemctl start xdev
   sudo xdev doctor --env-file /etc/xdev/environment
   sudo journalctl -u xdev -f
   ```

## Recommended installation: system service

```bash
git clone git@github.com:Mars-Wu/xdev-agent.git
cd xdev-agent/xdev
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

Choose one of these text-provider blocks.

**Option A: GLM text**

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

**Option B: DeepSeek text**

```bash
XDEV_LLM_PROVIDER=deepseek
XDEV_MODEL_PRESET=deepseek-hybrid
DEEPSEEK_API_KEY=your_deepseek_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Common optional settings:

```bash
XDEV_LLM_PROVIDER=glm
XDEV_MODEL_PRESET=glm-default
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/anthropic
FEISHU_USE_WEBSOCKET=true
XDEV_HOME=/var/lib/xdev
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_LOG_LEVEL=info
```

To switch the text stack to DeepSeek in one change:

```bash
XDEV_LLM_PROVIDER=deepseek
XDEV_MODEL_PRESET=deepseek-hybrid
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

`deepseek-hybrid` maps the main/coder roles to `deepseek-v4-pro` and the router/selector/background/auxiliary roles to `deepseek-v4-flash`.

Keep the explicit `XDEV_MODEL`, `XDEV_ROUTER_MODEL`, `XDEV_SELECTOR_MODEL`, and similar role overrides **commented out unless you intentionally want to override the preset**. Otherwise a leftover GLM role override can silently defeat a DeepSeek preset.

Vision remains separate and can keep using GLM through `XDEV_VISION_API_KEY`.

After startup, verify the service:

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
curl http://127.0.0.1:8081/health
sudo journalctl -u xdev -f
```

## Run from source

```bash
git clone git@github.com:Mars-Wu/xdev-agent.git
cd xdev-agent/xdev
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
npm run benchmark:models
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

## Feishu and `lark-cli`

`xdev` can run without `lark-cli`, but in practice `lark-cli` is the fastest way to:

- initialize Feishu app config locally
- authenticate as a user for live testing
- send benchmark messages to the bot
- inspect chat history and verify replies

See [`../docs/feishu-cli-guide.md`](../docs/feishu-cli-guide.md) for the quick install and auth flow.

## Boundaries and current focus

- Linux + `systemd` + Feishu is the primary supported deployment model
- Image and file flows depend on correct Feishu resource scopes
- Live Feishu tests still benefit from manual verification around media handling
- For local development only, source mode is fine; for durable service behavior, use the installer

## License

[MIT](../LICENSE) © 2025 wxy
