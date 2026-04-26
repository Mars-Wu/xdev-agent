# T03 · Command Safety Hardening

## Problem

A short denylist is not enough for a tool that can execute shell commands.

## Proposal

- expand dangerous-pattern detection
- distinguish hard blocks from soft warnings
- catch destructive filesystem commands, remote-script execution, and other high-risk patterns
- keep auditing information for rejected commands

## Goal

Reduce the chance that prompt injection or operator error leads to destructive shell execution.

