# T06 · Lazy-Loaded Subdirectory Hints

## Problem

When the agent moves into a new subdirectory, it may miss local instruction files or repository guidance that should shape behavior.

## Proposal

- track directories reached through tool usage
- look upward for recognized instruction files such as `AGENTS.md`, repository guidance files, or `.cursorrules`
- append relevant hints to tool results instead of bloating the base system prompt
- scan discovered guidance for prompt-injection patterns before reuse

## Goal

Give the agent local context only when it is actually needed.

