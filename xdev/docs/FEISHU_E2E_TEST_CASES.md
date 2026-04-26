# Xdev Feishu End-to-End Test Cases

## Goal

Validate xdev in both Feishu direct-message and group-chat scenarios.

Coverage areas:

1. message receipt and reply
2. continued conversations and topic memory
3. clarification flows
4. project snapshot, workflow, task, and operational tooling
5. edge cases such as long messages and media input
6. consistency between chat results, logs, and exported artifacts

## Preconditions

1. xdev is built and running as a `systemd` user service
2. `lark-cli auth status` and `lark-cli doctor` both pass
3. target `CHAT_ID` is available
4. the terminal exports the target chat variable

```bash
export CHAT_ID=<target_chat_id>
```

## Helper commands

```bash
cd /path/to/xdev
npm run build
npm run test:integration
systemctl --user restart xdev
systemctl --user status xdev --no-pager
journalctl --user -u xdev -n 100 --no-pager
```

## Suggested test matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| IM-001 | basic text question | relevant response arrives in chat |
| IM-002 | follow-up question | xdev keeps the prior turn in context |
| IM-003 | topic switch | unrelated request does not inherit the wrong project context |
| IM-004 | clarify flow | user can resolve ambiguity cleanly |
| IM-005 | slash-style operational command | command is handled or rejected clearly |
| IM-006 | image or file input | xdev handles media or reports a clear limit |

## Evidence to keep

- sent input
- returned reply
- service log excerpt
- any exported report or task state produced during the run
