# Copilot Instructions for claudeClaw / 艾克斯

## Project Overview

**艾克斯 (Xdev)** is an autonomous AI butler service running as a systemd user service. It connects to the Zhipu GLM API (Claude-compatible endpoint) and communicates with users via Feishu (Lark) as the primary channel, with a CLI for management. The main application lives in `xdev/`.

## Build, Test & Service Commands

All commands run from `xdev/`:

```bash
npm run build          # tsc + copy builtin skills to dist/
npm run dev            # ts-node (no build needed for dev)
npm run watch          # incremental tsc watch

npm test               # vitest run (all *.test.ts under src/)
npm run test:watch     # vitest in watch mode
npx vitest run src/memory/memory-manager.test.ts  # run single test file

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
Plugin SDK (EventBus pub/sub — Feishu plugin is the only built-in consumer)
         ↓
Storage Layer (SQLite via better-sqlite3, config hot-reload, telemetry)
```

Key module map:
- `src/index.ts` — bootstrap: wires all subsystems, registers Feishu webhook handlers
- `src/core/llm-client.ts` — single LLMClient wrapper around `@anthropic-ai/sdk`; uses `GLM_CONFIG` (baseURL + apiKey from `ZHIPU_API_KEY`)
- `src/core/glm-extensions.ts` — Zhipu-specific thinking mode, task complexity analysis
- `src/agent/autonomous-agent.ts` — polls `tools/task-system.ts` for claimable tasks
- `src/skills/` — markdown-driven skill definitions loaded at runtime (`builtins/` copied to `dist/skills/` on build)
- `src/plugin-sdk/event-bus.ts` — all cross-module events go through here (`EventTypes`)
- `src/gateway/server.ts` — WebSocket server; used by `bin/cli` and external tooling

## Key Conventions

### LLM / API
- The project targets the **Zhipu GLM API** with a Claude-compatible base URL. Set `ZHIPU_API_KEY` (or fallback `ANTHROPIC_AUTH_TOKEN`) and optionally `GLM_BASE_URL`.
- `resolveModelName()` in `src/core/model-config.ts` maps logical model names to GLM-specific strings — always use this instead of hardcoding model IDs.
- Streaming is the norm: `LLMClient.chat()` returns `AsyncGenerator<ChatEvent>`.

### Skills
- Built-in skills are markdown files under `src/skills/builtins/`. The build step copies them to `dist/skills/`.
- New skills follow the same markdown format: front-matter metadata + prompt body.
- `src/skills/registry.ts` is the single source of truth for available skills.

### Plugin System
- Plugins implement the interface in `src/plugin-sdk/types.ts` (`init()` / `destroy()` / event handlers).
- Emit and subscribe via `eventBus` from `src/plugin-sdk/event-bus.ts`; never call plugin internals directly.

### Tool System
- Tools in `src/tools/` are registered in `src/tools/index.ts`.
- Task graphs (`task-system.ts`) support DAG-style dependencies; `task-tool.ts` exposes this to the LLM.
- Background jobs (`background-tool.ts` / `background-tasks.ts`) run in-process — no worker threads.

### Configuration
- Runtime config lives in `config/` (YAML + env). `configManager` in `src/config/index.ts` supports hot-reload.
- Path constants are exported from `src/config/index.ts` as `PATHS`.
- Copy `.env.example` to `.env`; required vars: `ZHIPU_API_KEY`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`.

### TypeScript
- `strict: true`, target `ES2022`, module `commonjs`.
- All imports use relative paths (no path aliases configured).
- `src/utils/logger.ts` provides `createLogger(name)` — use this, not `console.log`.

### Worker Pattern
- The `workers/` directory stores timestamped self-optimization sessions. Each session has a `task.md` and `CLAUDE.md`. `CLAUDE.md` at the repo root is a symlink to the active worker session.
- `xdev/workspace/` is the working directory used by agents during autonomous task execution.
