# T10 · Interrupt Signal

## Problem

Long-running commands need a clean way to stop when the user sends an interrupt or stop request.

## Proposal

- maintain a shared interrupt flag
- let shell execution and the main loop check it regularly
- return a clear interrupted state instead of hanging or silently failing

## Goal

Make long-running execution responsive to operator control.

