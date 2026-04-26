# Harness Engineering Analysis (2026)

This document captures the main harness-engineering lessons that apply to xdev after reviewing industry references and the repository structure.

## What xdev already does well

- durable local state via SQLite
- explicit tool registry and workflow runtime
- service-oriented deployment model
- exported artifacts for debugging and review

## Where xdev still benefits from improvement

| Area | Opportunity |
| --- | --- |
| Documentation | keep public docs concise, current, and English-first |
| Validation | expand lightweight automated checks around high-risk flows |
| Resume behavior | make long-running work easier to inspect and continue |
| Safety | continue tightening shell, URL, and secret-handling paths |

## Recommendations

1. Keep architecture and operational docs synchronized.
2. Prefer reusable design notes over provider-branded narratives.
3. Preserve worker history, but make public docs independent from internal session artifacts.

