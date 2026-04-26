# T08 · Fuzzy Replacement for File Edits

## Problem

Exact string replacement fails too often when the model reproduces formatting slightly differently.

## Proposal

- keep exact matching first
- fall back through whitespace, quote, and indentation normalization strategies
- support boundary-aware block matching when exact text is close but not identical

## Goal

Reduce wasted retries while keeping edits predictable.

