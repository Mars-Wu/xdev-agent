# Harness Engineering Best Practices

This note consolidates best practices for repositories that host tool-using coding agents.

## Environment design

- Keep guidance files short and composable.
- Let the repository hold the authoritative state.
- Use clear directory boundaries and predictable file names.

## Feedback loops

- Make tests cheap to run.
- Keep logs readable and easy to correlate with actions.
- Export structured status when the runtime is long-lived.

## Safety

- Constrain shell and network access.
- Redact secrets in logs and surfaced tool output.
- Require explicit handling for destructive actions.

## Workflow design

- Prefer incremental progress over one-shot rewrites.
- Record what changed and what still blocks completion.
- Separate stable system guidance from task-specific notes.

## Application to xdev

xdev benefits most from strong observability, durable task state, and clear docs around service operation.

