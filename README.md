# xdev-agent

`xdev-agent` is an open source, Feishu-first AI agent runtime for engineering and operations work that needs to stay alive, keep context, and act on real tools instead of only producing chat replies.

The main application lives in [`xdev/`](xdev/). The repository is named **xdev-agent**, while the application and runtime inside it are still named **xdev**. It uses the Zhipu GLM API through an Anthropic-compatible interface and is designed to run reliably on Linux with `systemd`.

## What xdev-agent solves

Most chat bots are good at answering a message once, but weak at operating as a durable service. `xdev-agent` is built for the gaps between a demo bot and a real internal assistant:

- **Long-running operation** instead of short-lived chat sessions
- **Feishu-native workflows** instead of generic web chat only
- **Tool execution and task graphs** instead of plain text responses
- **Context continuity** through memory, topic routing, and history aggregation
- **Operational visibility** through exportable runtime artifacts and service diagnostics

In practice, this means you can run an assistant in Feishu that can respond to people, work through multi-step tasks, keep track of related topics over time, and behave like a maintainable service on a Linux host.

## Key characteristics

| Area | What stands out |
| --- | --- |
| Feishu-first design | Built around Feishu messaging, events, and `lark-cli`-based integrations |
| Durable runtime | Intended for `systemd` deployment with explicit service, logs, health checks, and runtime home |
| Agent execution | Supports tools, workflows, background jobs, and DAG-style task execution |
| Context handling | Includes memory extraction, topic routing, summaries, and history-aware prompt building |
| Operational introspection | Exports codebase, task, topic, and memory artifacts for debugging and review |
| Test coverage | Includes local tests, integration tests, and live Feishu validation flows |

## Typical use cases

- Run a Feishu bot that can do more than answer questions, such as invoking tools and handling multi-step workflows
- Operate an internal engineering or ops assistant as a recoverable service instead of a transient script
- Preserve and inspect long-running conversational context, topic grouping, and memory output
- Build a practical Feishu automation layer on top of GLM models without re-creating service scaffolding from scratch

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

## License

This repository is released under the **MIT License**. You may use, modify, distribute, and include it in commercial projects as long as the copyright notice and license text are preserved.

See [`LICENSE`](LICENSE) for the full terms. The software is provided **"as is"**, without warranty of any kind.
