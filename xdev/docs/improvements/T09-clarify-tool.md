# T09 · Clarify Tool

## Problem

Ambiguous requests are hard to resolve efficiently through free-form back-and-forth alone.

## Proposal

- let the agent send a structured question with a short option list
- keep platform-specific interaction handling in the host layer
- return a structured result that the main agent loop can use immediately

## Goal

Make ambiguity resolution faster and more reliable in both CLI and Feishu flows.

