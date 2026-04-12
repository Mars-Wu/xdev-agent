# T09 · Clarify 工具（结构化多选题交互）

> 参考: `~/data/hermes-agent/tools/clarify_tool.py`  
> 目标文件: 新建 `src/tools/clarify-tool.ts`，修改 `src/tools/index.ts`

---

## 问题背景

Agent 遇到歧义任务时（如"帮我优化代码"不知道优化方向），只能用普通文本询问用户，
用户需要理解问题再自由回复。Clarify 工具允许 Agent 发送带选项的多选题，交互更清晰。

---

## Hermes 设计要点

```
- LLM 调用 clarify(question, choices?) 工具
- choices 最多4个（UI 自动追加"其他（自由输入）"）
- 平台层注入具体的交互回调（CLI 用箭头键，飞书用消息回复）
- 返回 JSON：{ question, choices_offered, user_response }
- 超时（60s）后报错，Agent 继续工作
```

---

## 执行方案

### 1. 新建 `src/tools/clarify-tool.ts`

```typescript
import { createLogger } from '../utils/logger';

const logger = createLogger('clarify-tool');

// 工具定义（注册到 tool system）
export const CLARIFY_TOOL_DEFINITION = {
  name: 'clarify',
  description: '向用户提问以澄清任务歧义。支持多选题或开放式问题。在继续工作前需要用户确认重要决策时使用。',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '向用户提出的问题',
      },
      choices: {
        type: 'array',
        items: { type: 'string' },
        description: '最多4个预设选项（可选）。会自动追加"其他"选项。',
        maxItems: 4,
      },
    },
    required: ['question'],
  },
};

export interface ClarifyInput {
  question: string;
  choices?: string[];
}

export interface ClarifyResult {
  question: string;
  choices_offered: string[] | null;
  user_response: string;
}

/**
 * 平台交互回调类型
 * 由平台层注入（飞书消息 / CLI）
 * 返回用户的回复文本
 */
export type ClarifyCallback = (question: string, choices: string[] | null) => Promise<string>;

let _callback: ClarifyCallback | null = null;

/**
 * 注入平台回调（在 src/index.ts 启动时调用）
 */
export function setClarifyCallback(cb: ClarifyCallback): void {
  _callback = cb;
}

/**
 * Clarify 工具执行函数
 */
export async function executeClarify(input: ClarifyInput): Promise<string> {
  const { question, choices } = input;

  if (!question?.trim()) {
    return JSON.stringify({ error: 'question 不能为空' });
  }

  if (!_callback) {
    return JSON.stringify({ error: 'Clarify 工具在当前上下文不可用' });
  }

  const trimmedChoices = choices
    ?.slice(0, 4)
    .map(c => c.trim())
    .filter(Boolean) ?? null;

  try {
    const userResponse = await _callback(question.trim(), trimmedChoices);
    const result: ClarifyResult = {
      question: question.trim(),
      choices_offered: trimmedChoices,
      user_response: userResponse.trim(),
    };
    return JSON.stringify(result, null, 2);
  } catch (error: any) {
    logger.warn(`Clarify 工具交互失败: ${error.message}`);
    return JSON.stringify({ error: `获取用户输入失败: ${error.message}` });
  }
}
```

### 2. 注册到 `src/tools/index.ts`

```typescript
import { CLARIFY_TOOL_DEFINITION, executeClarify } from './clarify-tool';

// 在工具列表中添加：
export const TOOL_DEFINITIONS = [
  // ... 现有工具
  CLARIFY_TOOL_DEFINITION,
];

// 在工具执行分发中添加：
case 'clarify': {
  return await executeClarify(input as ClarifyInput);
}
```

### 3. 飞书消息层注入回调（`src/index.ts`）

在服务启动时注入飞书交互回调：

```typescript
import { setClarifyCallback } from './tools/clarify-tool';

// 飞书 Clarify 实现：发送消息并等待用户回复
setClarifyCallback(async (question, choices) => {
  // 构建飞书消息
  let messageText = question;
  if (choices && choices.length > 0) {
    const optionsText = choices.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const otherText = `${choices.length + 1}. 其他（请自由输入）`;
    messageText = `${question}\n\n${optionsText}\n${otherText}`;
  }

  // 发送消息
  await feishuClient.sendMessage(currentChatId, messageText);

  // 等待用户回复（最多60秒）
  return await waitForFeishuReply(currentChatId, 60_000);
});
```

飞书 `waitForFeishuReply` 实现：
```typescript
function waitForFeishuReply(chatId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(chatId);
      reject(new Error('等待用户回复超时（60秒）'));
    }, timeoutMs);

    pendingReplies.set(chatId, (text: string) => {
      clearTimeout(timer);
      pendingReplies.delete(chatId);
      resolve(text);
    });
  });
}

// 在消息接收处理中，检查 pendingReplies：
function handleIncomingMessage(chatId: string, text: string) {
  const pending = pendingReplies.get(chatId);
  if (pending) {
    pending(text); // 解析等待中的 promise
    return;
  }
  // 正常消息处理流程
  handleNormalMessage(chatId, text);
}
```

---

## 使用场景示例

```
用户: 帮我优化这段代码
→ LLM 调用: clarify("你希望优化的方向是什么？", ["性能", "可读性", "减少代码量", "内存占用"])

飞书显示:
你希望优化的方向是什么？
1. 性能
2. 可读性
3. 减少代码量
4. 内存占用
5. 其他（请自由输入）

用户回复: 2
→ LLM 收到: { user_response: "2" }
→ LLM 理解为"可读性"，继续优化工作
```

---

## 注意事项

- 飞书同一个 chatId 同一时间只能有一个 pending clarify（`pendingReplies` Map 中只存一个）
- 若用户在 clarify 等待期间发送新任务，新消息会被 clarify 拦截当作回复——这是预期行为
- 超时后 Agent 会收到 error，LLM 应自行决定是继续工作还是告知用户
- choices 选项数字（1/2/3/4）和选项文本都应被接受为有效回复
