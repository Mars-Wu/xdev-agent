# T02 · Anthropic Prompt Caching

> 参考: `~/data/hermes-agent/agent/prompt_caching.py`（72行纯函数）  
> 目标文件: 新建 `src/core/prompt-cache.ts`，修改 `src/core/llm-client.ts`，修改 `src/core/model-capabilities.ts`

---

## 问题背景

每轮对话完整发送所有 input tokens，无缓存。Anthropic 支持 `cache_control` 断点，
可将系统 prompt + 历史消息前缀缓存，相同前缀命中时费用降低约 75%（写入缓存 1.25x，
读取缓存 0.1x，未缓存 1x）。

**注意**：GLM API（Zhipu）不支持 `cache_control`，本功能通过 `supportsPromptCaching`
能力标志控制，仅对 Anthropic 原生端点有效。

---

## Hermes 算法（`system_and_3` 策略）

```
策略：最多4个 cache_control 断点（Anthropic 硬限制）
  1. system prompt                       → 断点1（最稳定，命中率最高）
  2. 最近第3个非 system 消息             → 断点2
  3. 最近第2个非 system 消息             → 断点3
  4. 最近第1个非 system 消息（最后一条） → 断点4
```

各消息内容格式处理：
- `string` 内容 → 转为 `[{ type: "text", text: "...", cache_control: { type: "ephemeral" } }]`
- `array` 内容 → 在最后一个 block 上添加 `cache_control`
- `tool` 角色 → 直接在消息对象上添加 `cache_control`（Anthropic native 格式）

---

## 执行方案

### 1. 新建 `src/core/prompt-cache.ts`

```typescript
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export const CACHE_MARKER: CacheControl = { type: 'ephemeral' };

/**
 * 在消息的最后一个 content block 上注入 cache_control 断点
 */
function applyCacheMarker(msg: Record<string, any>, marker: CacheControl): void {
  const { role, content } = msg;

  if (content === null || content === undefined || content === '') {
    msg.cache_control = marker;
    return;
  }

  if (typeof content === 'string') {
    msg.content = [{ type: 'text', text: content, cache_control: marker }];
    return;
  }

  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (typeof last === 'object' && last !== null) {
      last.cache_control = marker;
    }
  }
}

/**
 * 应用 system_and_3 缓存策略：最多4个断点
 * - 第1个：system prompt（若存在）
 * - 后3个：最近的非 system 消息
 *
 * @returns 深拷贝的消息列表（不修改原始消息）
 */
export function applyPromptCaching(
  messages: Record<string, any>[],
  cacheTtl: '5m' | '1h' = '5m',
): Record<string, any>[] {
  if (!messages || messages.length === 0) return messages;

  const result = JSON.parse(JSON.stringify(messages)); // 深拷贝
  const marker: CacheControl = { type: 'ephemeral' };
  if (cacheTtl === '1h') marker.ttl = '1h';

  let breakpointsUsed = 0;

  // 断点1：system prompt
  if (result[0]?.role === 'system') {
    applyCacheMarker(result[0], marker);
    breakpointsUsed++;
  }

  // 断点2-4：最近的非 system 消息
  const remaining = 4 - breakpointsUsed;
  const nonSysIndices = result
    .map((_: any, i: number) => i)
    .filter((i: number) => result[i]?.role !== 'system');

  for (const idx of nonSysIndices.slice(-remaining)) {
    applyCacheMarker(result[idx], marker);
  }

  return result;
}
```

### 2. 修改 `src/core/model-capabilities.ts`

在 `ModelCapability` 接口添加字段：

```typescript
export interface ModelCapability {
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsPromptCaching: boolean; // 新增
}
```

在各模型定义中设置（GLM 模型均为 `false`，Anthropic Claude 模型为 `true`）：
```typescript
// GLM 模型
supportsPromptCaching: false

// 若未来添加 claude-3-* 直连支持
supportsPromptCaching: true
```

### 3. 修改 `src/core/llm-client.ts`

在 `chat()` 和 `chatSync()` 方法中，发送请求前检查并应用缓存：

```typescript
import { applyPromptCaching } from './prompt-cache';
import { getModelCapabilities } from './model-capabilities';

// 在构建 params 之后、API 调用之前：
const capabilities = getModelCapabilities(params.model ?? this.defaultModel);
let finalMessages = params.messages;

if (capabilities.supportsPromptCaching) {
  finalMessages = applyPromptCaching(params.messages) as typeof params.messages;
}

// 记录缓存使用量（仅 Anthropic 返回这些字段）
// 在 usage 处理处添加：
if (usage.cache_read_input_tokens || usage.cache_creation_input_tokens) {
  logger.debug(
    `Prompt cache: read=${usage.cache_read_input_tokens ?? 0} create=${usage.cache_creation_input_tokens ?? 0}`
  );
}
```

---

## 测试用例

| 场景 | 期望结果 |
|------|---------|
| `supportsPromptCaching = false`（GLM） | 消息原样传递，无 `cache_control` |
| `supportsPromptCaching = true`，system + 5条消息 | system 消息有断点，最近3条消息有断点，共4个 |
| 消息 content 为 string | 转换为 `[{ type: "text", text, cache_control }]` |
| 消息 content 为 block array | 最后一个 block 上添加 `cache_control` |
| 原始消息对象 | `applyPromptCaching` 不修改（返回深拷贝） |

---

## 注意事项

- GLM/Zhipu 当前不支持 `cache_control`，传入会导致 API 错误，必须通过能力标志防护
- Anthropic 限制：最多4个断点，TTL 默认5分钟，`claude-3-5-sonnet-*` 及以上支持
- 缓存命中条件：消息前缀完全相同（包括 tool definitions），调整频繁的 system prompt 会导致缓存失效
