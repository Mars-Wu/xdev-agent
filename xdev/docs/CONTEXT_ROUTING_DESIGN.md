# Topic-Aware Context Routing Design

## Problem statement

A long-running assistant can answer the wrong question when unrelated history dominates the active conversation window. xdev introduced topic-aware routing to reduce cross-topic contamination while preserving the feel of a continuous chat.

## Design goal

Route each message through a topic decision step that happens outside the contaminated full-history prompt. The routing layer should decide whether to continue an existing topic or start a new one before the main reasoning loop consumes history.

## Why tool-only fixes are not enough

If the main model decides whether isolation is needed after it has already read the polluted context, the decision itself is biased. Routing therefore needs an earlier, cleaner stage.

## Proposed flow

```text
incoming message
  → lightweight topic classifier
  → topic lookup / create
  → topic-specific history assembly
  → main agent loop
  → background summary and memory update
```

## Data model

- topic id
- topic title
- topic summary
- message membership
- related memories and timestamps

## Success criteria

- project A and project B remain separated in long chats
- follow-up questions stay attached to the right topic
- routing state is inspectable in exported artifacts
- failures degrade gracefully to recent-history behavior instead of breaking replies

