# Xdev Architecture Overview

> Updated for the English-first repository cleanup.

xdev is organized as a long-running assistant service rather than a one-shot chat application. The design centers on Feishu message intake, a tool-capable agent loop, persistent runtime state, and operational visibility.

## Primary components

| Layer | Responsibility |
| --- | --- |
| Feishu integration | Receive events, send replies, and host long-lived messaging sessions |
| Gateway | WebSocket control plane for CLI and external tooling |
| LLM client | Provider abstraction for GLM models exposed through an Anthropic-compatible API |
| Agent runtime | Multi-turn tool loop, skills, workflows, and background execution |
| Persistence | SQLite-backed state, memories, topic routing, and exported reports |
| Operations | Build, diagnosis, smoke checks, and service management |

## High-level flow

```text
Feishu message
  → hooks / gateway intake
  → context assembly and routing
  → agent loop with tools and skills
  → optional workflow / task execution
  → reply + persistent state update
  → exported observability artifacts
```

## Deployment assumptions

- Linux with `systemd` is the primary supported target.
- Feishu WebSocket event delivery is preferred over public callbacks.
- `lark-cli` is optional but useful for testing and structured Feishu actions.

## Design priorities

1. Keep the assistant running across long tasks.
2. Make state visible enough to debug failures.
3. Support operational commands without adding custom infrastructure.
4. Preserve room for topic routing, memory extraction, and background work.

## Related documents

- [`xdev-technical-design.md`](xdev-technical-design.md)
- [`xdev-implementation-details.md`](xdev-implementation-details.md)
- [`../xdev/README.md`](../xdev/README.md)
- [`../xdev/docs/GUIDE.md`](../xdev/docs/GUIDE.md)

