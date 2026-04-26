# Xdev Implementation Plan

This document keeps a concise planning view of the project after the documentation cleanup.

## Planning assumptions

- Linux + `systemd` remains the primary deployment path.
- Feishu is the main communication channel.
- Provider access should stay abstract enough to support Anthropic-compatible endpoints without changing project positioning.

## Delivery phases

| Phase | Focus | Status |
| --- | --- | --- |
| 1 | Core service skeleton, config, and CLI wiring | Completed |
| 2 | Feishu intake, message handling, and baseline tools | Completed |
| 3 | Workflow, task DAG, and background execution | Completed |
| 4 | Topic routing, memory, and observability exports | Completed |
| 5 | Hardening, diagnostics, and public repository cleanup | Ongoing |

## Current priorities

1. Keep runtime operations stable.
2. Improve clarity of public documentation.
3. Continue reducing provider-specific assumptions in docs and prompts.
4. Preserve testability through integration and live validation flows.

## Validation checklist

- `npm run build`
- `npm test`
- `npm run test:integration`
- `xdev doctor`
- `xdev smoke-check`
- targeted live Feishu checks when changing message behavior

## Reference documents

- [`xdev-implementation-details.md`](xdev-implementation-details.md)
- [`../xdev/docs/PHASE4_IMPLEMENTATION_PLAN.md`](../xdev/docs/PHASE4_IMPLEMENTATION_PLAN.md)
- [`../xdev/docs/TOOL_SYSTEM_PLAN.md`](../xdev/docs/TOOL_SYSTEM_PLAN.md)

