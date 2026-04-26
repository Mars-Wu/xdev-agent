# T07 · URL Safety and SSRF Protection

## Problem

Network-capable tools can be tricked into accessing private metadata endpoints or internal services.

## Proposal

- parse and validate requested hostnames
- block known metadata and loopback targets
- resolve DNS and reject private, reserved, or link-local addresses
- fail closed when resolution is uncertain

## Goal

Prevent SSRF-style access through shell or browser tooling.

