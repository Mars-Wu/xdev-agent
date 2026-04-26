# Copilot Instructions for Xdev

## Project Overview

**Xdev** is an autonomous AI assistant designed to run as a long-lived systemd user service. It connects to the Zhipu GLM API through an Anthropic-compatible interface and uses Feishu (Lark) as the main user channel, with a CLI for management. The main application lives in `xdev/`.

## Build, Test & Service Commands

All commands run from `xdev/`:

```bash
npm run build          # tsc + copy builtin skills to dist/
npm run dev            # ts-node (no build needed for dev)
npm run watch          # incremental tsc watch

npm test               # vitest run (all *.test.ts under src/)
npm run test:watch     # vitest in watch mode
npx vitest run src/memory/memory-manager.test.ts  # run one test file

npm run test:coverage  # v8 coverage → text/json/html
```

Service management:

```bash
systemctl --user restart xdev
systemctl --user status xdev
journalctl --user -u xdev -f
```

## Architecture

```
Communication Layer (Feishu webhook + CLI gateway-cli)
         ↓
Gateway Server (WebSocket :18789) — real-time RPC & events
         ↓
Core LLM Client (Anthropic SDK → Zhipu GLM endpoint)
         ↓
Agent Layer (AutonomousAgent polls task board; InProcessAgent for direct calls)
         ↓
Skills / Tool System (registry-loaded skills + task DAGs + memory + browser)
         ↓
Plugin SDK (EventBus pub/sub — Feishu plugin is the built-in consumer)
         ↓
Storage Layer (SQLite via better-sqlite3, config hot-reload, telemetry)
```

Key module map:

- `src/index.ts` — bootstrap and Feishu event wiring
- `src/core/llm-client.ts` — single LLM client wrapper around `@anthropic-ai/sdk`
- `src/core/glm-extensions.ts` — Zhipu-specific thinking mode and task complexity helpers
- `src/agent/autonomous-agent.ts` — autonomous task polling loop
- `src/skills/` — markdown-driven skills copied to `dist/skills/` during build
- `src/plugin-sdk/event-bus.ts` — cross-module events and `EventTypes`
- `src/gateway/server.ts` — WebSocket server for the CLI and external tooling

## Key Conventions

### LLM / API

- Use the Zhipu GLM API with `ZHIPU_API_KEY` (or fallback `ANTHROPIC_AUTH_TOKEN`) and optional `GLM_BASE_URL`.
- Always go through `resolveModelName()` in `src/core/model-config.ts` instead of hardcoding provider model strings.
- `LLMClient.chat()` streams results as `AsyncGenerator<ChatEvent>`.

### Skills

- Built-in skills live under `src/skills/builtins/` as markdown files.
- New skills follow the same front-matter + prompt-body format.
- `src/skills/registry.ts` is the source of truth for skill registration.

### Plugin System

- Plugins implement the interfaces in `src/plugin-sdk/types.ts`.
- Use the event bus for integration boundaries; do not call plugin internals directly.

### Tool System

- Register tools in `src/tools/index.ts`.
- Task graphs in `task-system.ts` are DAG-based.
- Background jobs run in-process.

### Configuration

- Runtime config lives in `config/` and supports hot reload through `configManager`.
- Path constants are exported from `src/config/index.ts` as `PATHS`.
- Copy `.env.example` to `.env`; required values are `ZHIPU_API_KEY`, `FEISHU_APP_ID`, and `FEISHU_APP_SECRET`.

### TypeScript

- `strict: true`, target `ES2022`, module `commonjs`
- Relative imports only
- Use `createLogger(name)` from `src/utils/logger.ts`

### Worker Pattern

- `workers/` stores timestamped self-optimization sessions.
- Each worker session includes `task.md` plus its session-specific instruction file.
- `xdev/workspace/` is the working directory used by autonomous runs.

