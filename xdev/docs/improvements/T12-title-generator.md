# T12 · Conversation Title Generator

## Problem

Random topic IDs are hard to interpret in logs and historical views.

## Proposal

- generate a short descriptive title after the first exchange
- keep the work asynchronous so the main reply is not delayed
- silently skip title generation when the helper path fails

## Goal

Make topic history and exported artifacts easier for operators to read.

