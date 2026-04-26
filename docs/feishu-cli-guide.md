# Feishu CLI Guide

`lark-cli` exposes Feishu platform capabilities to a terminal or agent workflow. In xdev it is especially useful for setup, live testing, and validating structured Feishu operations outside the main service runtime.

## Install and authenticate

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login
lark-cli auth status --verify
```

## Common commands

```bash
lark-cli doctor
lark-cli im +messages-send --as user --chat-id <chat_id> --text "hello"
lark-cli im +messages-search --chat-id <chat_id> --limit 10
lark-cli contact +search-user --keyword <name>
```

## How it fits xdev

- verify Feishu authentication and scopes
- send regression messages to the bot
- inspect chat history or fetch test artifacts
- exercise structured Feishu APIs without changing xdev runtime code

## Practical advice

- Use a dedicated test chat when validating multi-turn behavior.
- Verify message, image, and file scopes before testing rich media.
- Keep user-mode actions separate from bot-mode actions when permissions differ.

## Related docs

- [`feishu-message-test-cases.md`](feishu-message-test-cases.md)
- [`../xdev/docs/FEISHU_E2E_TEST_CASES.md`](../xdev/docs/FEISHU_E2E_TEST_CASES.md)

