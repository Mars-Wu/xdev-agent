# T02 · Prompt Caching

## Problem

Re-sending the same system prompt and stable history prefix on every turn wastes tokens when the upstream provider supports prompt caching.

## Proposal

- expose a provider capability flag such as `supportsPromptCaching`
- attach cache markers only for providers that support them
- cache the system prompt and a few stable history boundaries
- keep GLM-safe behavior by disabling cache metadata on unsupported endpoints

## Notes

xdev currently targets GLM through an Anthropic-compatible API surface. Native prompt-caching behavior should remain optional and provider-gated.

