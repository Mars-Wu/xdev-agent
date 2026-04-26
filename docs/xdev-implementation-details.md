# Xdev Implementation Details

This is a condensed English summary of the implementation concepts previously captured in a much longer internal design note.

## Runtime model

- A long-lived service receives Feishu events.
- The message pipeline assembles context, chooses the next action, and runs the tool-capable agent loop.
- Larger tasks can be staged into workflows, background jobs, or autonomous execution loops.

## Important subsystems

### Gateway and hooks

The gateway exposes a WebSocket control plane for CLI and remote tools. Hooks and Feishu handlers translate external events into the internal agent runtime.

### LLM integration

The repository uses a single LLM client wrapper. Provider-specific settings stay in configuration and model mapping, not in the public positioning of the project.

### Skills and tools

- Markdown skills provide reusable prompt-level behavior.
- Tool registration centralizes shell, file, browser, and task operations.
- Background tasks keep longer work separate from the immediate reply path.

### State management

- Message history supports compaction.
- Topic routing keeps unrelated conversations apart.
- Memory extraction and exported reports make the system easier to inspect.

## Operational expectations

- Run as a service when durability matters.
- Keep health checks, logs, and export artifacts available.
- Use live Feishu tests for message-path regressions.

## Related references

- [`xdev-architecture.md`](xdev-architecture.md)
- [`xdev-capability-list.md`](xdev-capability-list.md)
- [`../xdev/docs/GUIDE.md`](../xdev/docs/GUIDE.md)
