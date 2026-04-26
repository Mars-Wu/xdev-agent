# Feishu Message Test Cases for Xdev

## Goal

Validate the main Feishu message path end to end: intake, reasoning, reply delivery, and service observability.

## Preconditions

1. xdev is running and both `ws://127.0.0.1:18789/health` and `http://127.0.0.1:8081/health` report healthy status.
2. `lark-cli auth status --verify` and `lark-cli doctor` succeed.
3. Tests run in an isolated direct message or private group.
4. Any media fixtures needed for image, file, or audio tests are prepared ahead of time.

## Suggested matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| T01 | single-turn text question | xdev returns a relevant plain-text answer |
| T02 | multi-turn continuation | follow-up turn correctly remembers the prior exchange |
| T03 | markdown or rich text inbound message | xdev responds to the content, not raw transport payload |
| T04 | unknown slash-style command | xdev fails gracefully with a clear error or help message |
| T05 | image message | bot receives and acknowledges or explains current limits |
| T06 | file message | file handling path works or fails with a useful explanation |

## Execution helpers

```bash
cd /path/to/xdev
npm run build
systemctl --user restart xdev
systemctl --user status xdev --no-pager
```

## Evidence to collect

- sent command or message payload
- xdev reply text
- relevant service logs
- any exported report or task artifact created during the run
