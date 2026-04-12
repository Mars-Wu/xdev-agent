# T12 · 会话标题自动生成

> 参考: `~/data/hermes-agent/agent/title_generator.py`（60行）  
> 目标文件: 新建 `src/core/title-generator.ts`，修改 `src/storage/topic-graph.ts`，修改 `src/index.ts`

---

## 问题背景

话题 ID 是随机字符串（如 `T_1775403725279_1zvg`），在飞书历史消息、日志中难以辨认。
首轮对话后异步生成标题，用户无感知延迟。

---

## Hermes 设计要点

```python
_TITLE_PROMPT = (
    "Generate a short, descriptive title (3-7 words) for a conversation "
    "that starts with the following exchange. Return ONLY the title text."
)

# 截断前500字符，保持请求小
# max_tokens=30，temperature=0.3
# 后台线程异步执行，不阻塞主回复
# 失败静默忽略
```

---

## 执行方案

### 1. 新建 `src/core/title-generator.ts`

```typescript
import { auxChat } from './auxiliary-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('title-generator');

const TITLE_SYSTEM_PROMPT = `你是对话标题生成器。
根据用户的第一条消息和助手的回复，生成一个简短的中文标题（3-7个字）。
标题应概括对话的主要话题或意图。
只输出标题文字，不要标点、不要引号、不要前缀。`;

/**
 * 生成话题标题
 * 使用辅助模型（glm-4.7-flash），max_tokens=30，temperature=0.3
 * 失败返回 null
 */
export async function generateTopicTitle(
  userMessage: string,
  assistantReply: string,
): Promise<string | null> {
  const userSnippet = userMessage.slice(0, 500);
  const replySnippet = assistantReply.slice(0, 500);

  const prompt = `用户: ${userSnippet}\n\n助手: ${replySnippet}`;

  try {
    const title = await auxChat(prompt, {
      system: TITLE_SYSTEM_PROMPT,
      maxTokens: 30,
      temperature: 0.3,
    });

    if (!title) return null;

    // 清理：去除引号、多余标点、"标题:" 前缀
    let cleaned = title.trim().replace(/^["']|["']$/g, '');
    if (/^标题[:：]\s*/i.test(cleaned)) {
      cleaned = cleaned.replace(/^标题[:：]\s*/i, '');
    }

    // 限制长度
    if (cleaned.length > 30) cleaned = cleaned.slice(0, 27) + '...';

    return cleaned || null;
  } catch (error: any) {
    logger.debug(`标题生成失败（静默忽略）: ${error.message}`);
    return null;
  }
}

/**
 * 异步生成话题标题并更新（fire-and-forget）
 * 只在前2轮用户消息时触发
 *
 * @param updateFn 回调函数，接收生成的标题并更新存储
 */
export function autoGenerateTitle(
  userMessage: string,
  assistantReply: string,
  userMessageCount: number,
  updateFn: (title: string) => void,
): void {
  // 只在前2轮触发
  if (userMessageCount > 2) return;
  if (!userMessage || !assistantReply) return;

  // Fire-and-forget：不 await，不阻塞当前回复
  setImmediate(async () => {
    const title = await generateTopicTitle(userMessage, assistantReply);
    if (title) {
      try {
        updateFn(title);
        logger.debug(`自动生成话题标题: "${title}"`);
      } catch (error: any) {
        logger.debug(`设置话题标题失败: ${error.message}`);
      }
    }
  });
}
```

### 2. 修改 `src/storage/topic-graph.ts`

确保 `Topic` 接口有 `title` 字段，并添加 `updateTopicTitle` 方法：

```typescript
// Topic 接口（确认字段已存在或添加）：
export interface Topic {
  id: string;
  title?: string;  // 若已存在保留，若不存在添加
  createdAt: number;
  updatedAt: number;
  // ... 其他字段
}

// 添加方法：
updateTopicTitle(topicId: string, title: string): void {
  const topic = this.topics.get(topicId);
  if (!topic) return;
  topic.title = title;
  topic.updatedAt = Date.now();
  this.saveTopic(topic);  // 持久化到 SQLite
  logger.debug(`话题标题已更新: ${topicId} → "${title}"`);
}
```

### 3. 修改 `src/index.ts`（飞书消息处理器）

在首轮 agent loop 完成后触发：

```typescript
import { autoGenerateTitle } from './core/title-generator';

// 在 handleMessage() 中，agent loop 完成后：
const userMsgCount = topic.messageCount; // 当前用户消息数
autoGenerateTitle(
  userMessage,
  assistantReply,    // agent 本轮最终回复
  userMsgCount,
  (title) => topicGraph.updateTopicTitle(currentTopicId, title),
);
```

---

## 触发时机图示

```
用户第1条消息 → Agent 处理 → 回复用户
                           ↓ setImmediate（异步，不阻塞回复）
                     generateTopicTitle()
                           ↓ 调用 glm-4.7-flash (max_tokens=30)
                     updateTopicTitle("帮我写一个排序算法")
                           ↓ 持久化到 SQLite
用户第2条消息 → Agent 处理（标题已存在，autoGenerateTitle 跳过）
```

---

## 测试用例

| 场景 | 期望结果 |
|------|---------|
| 正常对话首轮 | 生成3-7字中文标题，持久化到话题 |
| 辅助模型失败 | `null` 返回，话题 title 保持为空，无报错 |
| 第3轮以后 | `autoGenerateTitle` 直接返回，不再触发 |
| 标题含引号 | 自动清除首尾引号 |
| 标题超30字 | 截断到27字 + `...` |
