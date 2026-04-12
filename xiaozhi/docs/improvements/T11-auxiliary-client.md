# T11 · 辅助 LLM 客户端

> 参考: `~/data/hermes-agent/agent/auxiliary_client.py`  
> 目标文件: 新建 `src/core/auxiliary-client.ts`，修改 `src/config/schema.ts`

---

## 问题背景

当前摘要压缩、标题生成、路由分类都使用主模型（GLM-5 系列），成本高且占用主模型 token 配额。
通过独立的辅助客户端，这些"便宜"任务可以路由到更快、更便宜的模型（如 `glm-4.7-flash`）。

---

## Hermes 设计要点

Hermes `auxiliary_client.py` 实现了复杂的多后端自动切换，但核心思路是：
- 辅助任务（compression、title）使用不同的模型
- 对外暴露统一的 `call_llm(task, messages, max_tokens)` 接口
- 失败自动 fallback（我们简化为单模型 + 错误静默处理）

---

## 执行方案

### 1. 修改 `src/config/schema.ts`

在 model 配置段新增字段：

```typescript
// ModelConfig 接口/验证中添加：
interface ModelConfig {
  defaultModel: string;
  fallbackModel?: string;
  maxTokens?: number;
  auxiliaryModel?: string; // 新增：用于轻量任务（压缩摘要、标题生成、路由分类）
}

// 验证逻辑：可选，若存在则必须为非空字符串
if (cfg.auxiliaryModel !== undefined && typeof cfg.auxiliaryModel !== 'string') {
  errors.push({ path: 'model.auxiliaryModel', message: 'auxiliaryModel 必须是字符串' });
}
```

### 2. 新建 `src/core/auxiliary-client.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { configManager } from '../config';
import { createLogger } from '../utils/logger';
import { resolveModelName } from './model-config';

const logger = createLogger('auxiliary-client');

// 默认辅助模型（GLM 快速版）
const DEFAULT_AUX_MODEL = 'glm-4.7-flash';

export interface AuxChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AuxChatOptions {
  messages: AuxChatMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AuxChatResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

class AuxiliaryClient {
  private client: Anthropic;
  private model: string;

  constructor() {
    const config = configManager.getConfig();
    const auxModelInput = config.model?.auxiliaryModel ?? DEFAULT_AUX_MODEL;
    this.model = resolveModelName(auxModelInput);

    this.client = new Anthropic({
      apiKey: process.env.ZHIPU_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '',
      baseURL: process.env.GLM_BASE_URL,
    });

    logger.debug(`辅助客户端初始化: model=${this.model}`);
  }

  /**
   * 同步风格的 LLM 调用（内部使用 await）
   * 失败时抛出错误（调用方负责静默处理）
   */
  async chat(options: AuxChatOptions): Promise<AuxChatResult> {
    const { messages, system, maxTokens = 500, temperature = 0.3 } = options;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: maxTokens,
      messages: messages as Anthropic.MessageParam[],
    };

    if (system) {
      params.system = system;
    }

    const response = await this.client.messages.create(params);
    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('');

    return {
      content,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

// 单例，懒初始化
let _instance: AuxiliaryClient | null = null;

export function getAuxiliaryClient(): AuxiliaryClient {
  if (!_instance) {
    _instance = new AuxiliaryClient();
  }
  return _instance;
}

/**
 * 便捷函数：单轮对话，失败返回 null
 * 适用于标题生成、路由分类等非关键任务
 */
export async function auxChat(
  userMessage: string,
  options?: Partial<AuxChatOptions>,
): Promise<string | null> {
  try {
    const result = await getAuxiliaryClient().chat({
      messages: [{ role: 'user', content: userMessage }],
      ...options,
    });
    return result.content;
  } catch (error: any) {
    logger.debug(`辅助客户端调用失败（静默忽略）: ${error.message}`);
    return null;
  }
}
```

### 3. 使用辅助客户端的地方

**压缩摘要**（修改 `src/core/message-history.ts`）：
```typescript
import { getAuxiliaryClient } from './auxiliary-client';

// 在 createStructuredSummary() 中：
const aux = getAuxiliaryClient();
const result = await aux.chat({
  messages: [{ role: 'user', content: prompt }],
  maxTokens: summaryBudget,
  temperature: 0.3,
});
return result.content;
```

**标题生成**（T12 中使用）：
```typescript
import { auxChat } from './auxiliary-client';
const title = await auxChat(prompt, { maxTokens: 30, temperature: 0.3 });
```

**路由分类**（修改 `src/core/message-router.ts`）：
```typescript
import { auxChat } from './auxiliary-client';
// 将原来 llmClient.chatSync() 替换为 auxChat()
```

---

## 配置示例

在 `config/config.yaml`（或 `.env`）中：
```yaml
model:
  defaultModel: glm-4.5
  auxiliaryModel: glm-4.7-flash  # 辅助任务用快速模型
  maxTokens: 100000
```

---

## 注意事项

- 辅助客户端使用相同的 API Key 和 Base URL（Zhipu）
- 单例模式：进程内只创建一个实例，配置在首次调用时读取
- 配置热重载：若 configManager 支持热重载，需在配置变更时重置 `_instance = null`
- `auxChat` 失败时返回 `null`，调用方应有降级处理（如跳过标题生成）
