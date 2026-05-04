# Xdev Deployment Guide

This guide is the main operational path for open source users. It focuses on installing, configuring, and troubleshooting xdev as a `systemd` service, with source mode available for development.

## Deployment modes

Recommended order:

1. **System service** for production or long-running usage
2. **Source mode** for development and debugging

| Mode | Code directory | Data directory | Environment file |
| --- | --- | --- | --- |
| system service | `/opt/xdev` | `/var/lib/xdev` | `/etc/xdev/environment` |
| source mode | repository checkout | `~/.xdev` | repository `.env` |

## Requirements

- Linux with `systemd`
- Node.js 18+
- npm 9+
- One text provider API key: GLM or DeepSeek
- Feishu custom app
- `lark-cli` recommended for setup and live validation

## Feishu app setup

At minimum, enable:

- bot capability
- WebSocket event delivery
- event subscription for `im.message.receive_v1`
- send/receive permissions for the message types you plan to use

Recommended IM-related scopes for first-time setup:

- `im:message`
- `im:message:readonly`
- `im:message.send_as_user`
- `im:chat:read`
- `im:chat:update` if you want chat management flows
- media/resource scopes if you want image or file tests

## Install and authenticate `lark-cli`

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login
lark-cli auth status --verify
```

Use `lark-cli` to:

- confirm Feishu app config is valid
- send live messages to the xdev bot
- inspect the chat after a benchmark or regression test

## Install as a service

```bash
git clone git@github.com:Mars-Wu/xdev-agent.git
cd xdev-agent/xdev
sudo ./install-xdev.sh
sudo editor /etc/xdev/environment
sudo systemctl start xdev
sudo systemctl status xdev
```

Minimum environment values for **GLM text**:

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Minimum environment values for **DeepSeek text**:

```bash
XDEV_LLM_PROVIDER=deepseek
XDEV_MODEL_PRESET=deepseek-hybrid
DEEPSEEK_API_KEY=your_deepseek_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Common optional values:

```bash
XDEV_LLM_PROVIDER=glm
XDEV_MODEL_PRESET=glm-default
ZHIPU_API_BASE_URL=https://open.bigmodel.cn/api/anthropic
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
FEISHU_USE_WEBSOCKET=true
XDEV_HOME=/var/lib/xdev
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_LOG_LEVEL=info
```

Important:

- If you use a preset such as `deepseek-hybrid`, keep explicit role overrides like `XDEV_MODEL` and `XDEV_ROUTER_MODEL` commented out unless you intentionally want custom routing.
- xdev currently uses **DeepSeek for text** and **GLM for vision** as separate configuration paths. DeepSeek's documented Anthropic-compatible path does not currently support `image` or `document` content blocks.

## Verify the service

```bash
sudo xdev doctor --env-file /etc/xdev/environment
sudo xdev smoke-check --env-file /etc/xdev/environment
curl http://127.0.0.1:8081/health
sudo journalctl -u xdev -f
```

## Run from source

```bash
cd /path/to/xdev
npm install
cp .env.example .env
npm run build
npm test
npm run dev
```

If you run Xdev as a local `systemd --user` service, prefer an external environment file such as `~/.config/xdev/environment` instead of relying on a repo-local `.env`.

## Troubleshooting checklist

- verify Feishu app credentials and scopes
- confirm WebSocket mode is enabled
- confirm the chosen text provider key is valid (`ZHIPU_API_KEY` or `DEEPSEEK_API_KEY`)
- check `journalctl` for provider or permission errors
- run `xdev doctor` before deeper debugging
- use [`FEISHU_E2E_TEST_CASES.md`](FEISHU_E2E_TEST_CASES.md) when the service is running but chat behavior looks wrong
