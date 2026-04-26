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
- Zhipu API key
- Feishu custom app

## Feishu app setup

At minimum, enable:

- bot capability
- WebSocket event delivery
- event subscription for `im.message.receive_v1`
- send/receive permissions for the message types you plan to use

## Install as a service

```bash
git clone git@github.com:wuxiaoyu19900108/xdev_agent.git
cd xdev_agent/xdev
sudo ./install-xdev.sh
sudo editor /etc/xdev/environment
sudo systemctl start xdev
sudo systemctl status xdev
```

Minimum environment values:

```bash
ZHIPU_API_KEY=your_zhipu_api_key_here
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

Common optional values:

```bash
GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic
FEISHU_USE_WEBSOCKET=true
XDEV_HOME=/var/lib/xdev
XDEV_GATEWAY_PORT=18789
XDEV_HOOKS_PORT=8081
XDEV_LOG_LEVEL=info
```

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
- check `journalctl` for provider or permission errors
- run `xdev doctor` before deeper debugging
- use [`FEISHU_E2E_TEST_CASES.md`](FEISHU_E2E_TEST_CASES.md) when the service is running but chat behavior looks wrong
