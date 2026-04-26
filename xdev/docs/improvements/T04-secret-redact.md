# T04 · Secret Redaction

## Problem

Secrets may appear in tool output, provider errors, or forwarded message content.

## Proposal

- detect common token and credential patterns
- redact environment-style `KEY=value` strings
- scrub JSON fields such as `token`, `apiKey`, or `secret`
- sanitize authorization headers in logs and surfaced output

## Goal

Keep debugging useful without leaking credentials.

