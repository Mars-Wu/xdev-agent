# Xdev Capability List

> Updated: 2026-04-14

## Current capability snapshot

| Category | Current capability | Status |
| --- | --- | --- |
| Primary channel | Feishu WebSocket bot | ✅ |
| Control plane | Gateway WebSocket + HTTP hooks API | ✅ |
| Main reasoning model | `glm-5-turbo` | ✅ |
| Routing / lightweight tasks | `glm-4.7-flash` | ✅ |
| Coding model | `glm-5` | ✅ |
| Vision model path | `glm-5v-turbo` via native chat completions | ✅ |
| Tool system | 36 built-in tools | ✅ |
| Built-in skills | 4 markdown-based skills | ✅ |
| Memory | Long-term memory, topic routing, background extraction | ✅ |
| Browser automation | Playwright | ✅ |
| Feishu tool bridge | Structured `lark-cli` tool set | ✅ |

## What the service can do today

- Hold multi-turn Feishu conversations
- Use local shell, file, browser, and workflow tools
- Track topics and keep longer-running task context
- Export runtime state for debugging and review
- Run as a durable service instead of a foreground script

## Supporting references

- [`../xdev/README.md`](../xdev/README.md)
- [`../xdev/docs/GUIDE.md`](../xdev/docs/GUIDE.md)
- [`feishu-message-test-cases.md`](feishu-message-test-cases.md)

