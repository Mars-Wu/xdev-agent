# Feishu CLI Guide

`lark-cli` exposes Feishu platform capabilities to a terminal or agent workflow. In xdev it is especially useful for setup, live testing, and validating structured Feishu operations outside the main service runtime.

## Install and authenticate

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login
lark-cli auth status --verify
```

`config init --new` is the step where you bind `lark-cli` to your Feishu app credentials. `auth login` is the user-side authorization step that lets you send messages as yourself for live tests.

For xdev, the most common first checks are:

```bash
lark-cli auth status
lark-cli doctor
```

If you want to benchmark xdev in a real Feishu chat, user identity is usually the most convenient path:

```bash
lark-cli im +messages-send --as user --chat-id <chat_id> --text "hello"
```

## How to fit `lark-cli` into xdev setup

Recommended order:

1. create and configure the Feishu custom app
2. run `lark-cli config init --new`
3. run `lark-cli auth login`
4. install and start xdev
5. use `lark-cli im ...` commands to send test messages to the bot

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
- If `auth status` shows `needs_refresh`, run `lark-cli auth login` again before debugging xdev.
- Treat `lark-cli` as the quickest way to prove whether a problem is in Feishu setup or in xdev runtime logic.

## Related docs

- [`feishu-message-test-cases.md`](feishu-message-test-cases.md)
- [`../xdev/docs/FEISHU_E2E_TEST_CASES.md`](../xdev/docs/FEISHU_E2E_TEST_CASES.md)
