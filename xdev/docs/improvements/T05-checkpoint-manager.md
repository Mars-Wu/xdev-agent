# T05 · Checkpoint Manager

## Problem

File edits performed by the agent are hard to roll back when something goes wrong.

## Proposal

- maintain a shadow checkpoint store outside the user repository metadata
- snapshot changes at useful loop boundaries rather than every tiny operation
- allow operators to inspect or restore previous states

## Goal

Make autonomous file edits safer and easier to recover.

