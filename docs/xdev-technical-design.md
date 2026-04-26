# Xdev Technical Design

This document summarizes the intended technical shape of xdev without tying the project to any single product brand.

## Goals

- Provide a durable Feishu-facing AI assistant
- Support both direct answers and multi-step task execution
- Route work through tools, workflows, and background jobs
- Preserve useful state through summaries, memories, and exported reports

## Functional scope

| Area | Requirement |
| --- | --- |
| Messaging | Receive Feishu messages and send structured replies |
| Direct assistance | Answer questions, read files, and perform small edits or diagnostics |
| Long-running work | Spawn or continue background tasks for larger jobs |
| Progress tracking | Surface task state and exported runtime artifacts |
| Session control | Manage history, routing, and resumable work |

## Main building blocks

1. **Feishu intake** for inbound events and replies
2. **Gateway server** for command and status transport
3. **LLM client** for model access and streaming responses
4. **Tool registry** for shell, file, browser, and service operations
5. **Workflow/task runtime** for staged or dependent execution
6. **Persistent state** for memory, topics, and observability exports

## Non-goals

- Supporting every messaging platform equally
- Replacing standard Linux service tooling
- Treating the assistant as a stateless chat-only experience

## Current implementation notes

- The model provider is Zhipu GLM behind an Anthropic-compatible API surface.
- Skills are markdown-driven and loaded at runtime.
- SQLite is the operational store for most local state.
- The repository keeps operational docs in `xdev/docs/` and public-facing summaries in `docs/`.

## See also

- [`xdev-architecture.md`](xdev-architecture.md)
- [`xdev-implementation-plan.md`](xdev-implementation-plan.md)
- [`xdev-capability-list.md`](xdev-capability-list.md)
