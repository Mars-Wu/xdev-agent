# xdev

`xdev` is an open source Feishu-first AI operations assistant designed for long-running work. The runtime lives in [`xdev/`](xdev/), uses the Zhipu GLM API through an Anthropic-compatible interface, and is intended to run reliably on Linux with `systemd`.

## What this repository is for

- Running an AI assistant in Feishu for engineering, operations, and project support
- Executing multi-step workflows with tasks, background jobs, and tool calls
- Preserving context through memory, topic routing, and exportable runtime artifacts
- Operating the service as a durable Linux service instead of a short-lived chat bot

## Repository layout

| Path | Purpose |
| --- | --- |
| `xdev/` | Main application, CLI, build scripts, runtime docs, and tests |
| `docs/` | Architecture notes, operational references, and supporting design documents |
| `.github/copilot-instructions.md` | Repository-specific Copilot guidance kept for contributor tooling |

## Quick start

```bash
git clone git@github.com:wuxiaoyu19900108/xdev_agent.git
cd xdev_agent/xdev
sudo ./install-xdev.sh
sudo editor /etc/xdev/environment
sudo systemctl start xdev
sudo xdev doctor --env-file /etc/xdev/environment
```

## Start reading here

- Project overview: [`xdev/README.md`](xdev/README.md)
- Deployment and troubleshooting: [`xdev/docs/GUIDE.md`](xdev/docs/GUIDE.md)
- Feishu end-to-end validation: [`xdev/docs/FEISHU_E2E_TEST_CASES.md`](xdev/docs/FEISHU_E2E_TEST_CASES.md)
- Architecture summary: [`docs/xdev-architecture.md`](docs/xdev-architecture.md)
- Technical design: [`docs/xdev-technical-design.md`](docs/xdev-technical-design.md)
- Feishu CLI workflow notes: [`docs/feishu-cli-guide.md`](docs/feishu-cli-guide.md)

## Development

```bash
cd xdev
npm install
npm run build
npm test
npm run test:integration
```

For live Feishu regression checks:

```bash
cd xdev
CHAT_ID=<chat_id> npm run test:live:feishu -- --focus unfinished
```

## Deployment defaults

- Service code directory: `/opt/xdev`
- Service data directory: `/var/lib/xdev`
- Service environment file: `/etc/xdev/environment`
- Local source-run data directory: `~/.xdev`

`xdev` uses `~/.xdev` as the default local runtime home.

