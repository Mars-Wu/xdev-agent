# Xdev Tool System Plan

This document summarizes the intent behind the tool-system expansion work.

## Objectives

- provide a coherent registry for built-in tools
- support skills and external integrations cleanly
- improve safety for shell, file, browser, and network operations
- make longer workflows easier to compose and observe

## Tool categories

| Category | Purpose |
| --- | --- |
| shell and file tools | local execution, reads, writes, edits, listing |
| browser tools | structured web interaction and capture |
| task/workflow tools | multi-step orchestration and progress tracking |
| skill tools | prompt-level reusable capabilities |
| integration tools | Feishu and other structured external systems |

## Delivery phases

1. baseline registry and execution boundaries
2. skill and integration expansion
3. safety hardening and better failure handling
4. observability, checkpoints, and resumability improvements

## Design constraints

- keep registration centralized
- preserve non-interactive operation paths
- avoid coupling public docs to any single model vendor
- favor features that improve repeatability and operator trust

