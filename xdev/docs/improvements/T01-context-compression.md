# T01 · Context Compression Rewrite

## Problem

The original history compression path could cut across tool boundaries and produce malformed message sequences.

## Proposal

- protect a small stable head section
- preserve recent turns by token budget rather than a fixed count
- align compression boundaries around tool request/result pairs
- generate a structured middle-summary instead of raw truncation
- support iterative summaries across repeated compressions

## Acceptance signals

- compressed histories remain valid for provider APIs
- tool-call structure is preserved
- long sessions shrink without losing the latest actionable context

