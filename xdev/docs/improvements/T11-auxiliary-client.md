# T11 · Auxiliary LLM Client

## Problem

Lightweight tasks such as summaries, titles, or routing should not always consume the main model path.

## Proposal

- add a secondary client for cheap or fast tasks
- route compression, title generation, and classification through that client
- keep the integration simple and optional

## Goal

Lower cost and reduce contention on the main reasoning model.

