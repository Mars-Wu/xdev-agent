# Notes on Effective Harnesses for Long-Running Agents

> Source inspiration: Anthropic engineering writing on long-running agent harnesses.

This repository used to store a near-verbatim note set tied to a specific product name. The public version keeps only the reusable ideas.

## Main takeaways

1. Long tasks need session-to-session continuity.
2. Initialization and incremental execution benefit from different prompts and responsibilities.
3. The repository itself should act as the durable record of progress.
4. Agents need explicit signals for what is finished and what remains.
5. Tooling, docs, and checkpoints matter as much as the model itself.

## Why this matters to xdev

xdev uses long-lived conversations, background execution, and exported runtime state. Harness quality determines whether those sessions stay understandable when the context window rolls forward.

## Recommended application

- keep concise repository maps
- record progress in durable files or task state
- preserve resumable operational context
- separate bootstrap guidance from incremental execution guidance

