# T04 · Secret 日志脱敏

> 参考: `~/data/hermes-agent/agent/redact.py`  
> 目标文件: 新建 `src/utils/redact.ts`，修改 `src/utils/logger.ts`，修改 `src/core/llm-client.ts`

---

## 问题背景

API Key、Token 等敏感信息可能出现在：
- 工具执行输出（如 `cat .env` 的内容）
- LLM API 错误信息（请求体 debug 日志）
- 飞书转发的消息内容

---

## 算法设计

### 脱敏规则

1. **已知 API Key 前缀模式**：匹配 30+ 种前缀（sk-、ghp_、AKIA 等），保留前6位和后4位
2. **环境变量赋值**：`KEY=value` 其中 KEY 含 API_KEY/TOKEN/SECRET/PASSWORD
3. **JSON 字段**：`"apiKey": "value"`、`"token": "value"` 等
4. **Authorization header**：`Authorization: Bearer <token>`

### 脱敏逻辑

```
若 token 长度 >= 18：保留前6位 + "****" + 后4位
若 token 长度 <  18：完全替换为 "****"
```

---

## 执行方案

### 1. 新建 `src/utils/redact.ts`

```typescript
/**
 * 在导入时从环境变量快照，防止运行时被 LLM 修改禁用
 */
const REDACT_ENABLED =
  !['0', 'false', 'no', 'off'].includes(
    (process.env.XDEV_REDACT_SECRETS ?? '').toLowerCase()
  );

/**
 * 已知 API Key 前缀正则模式
 */
const PREFIX_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,           // OpenAI / Anthropic / OpenRouter
  /ghp_[A-Za-z0-9]{10,}/g,            // GitHub PAT classic
  /github_pat_[A-Za-z0-9_]{10,}/g,    // GitHub PAT fine-grained
  /gho_[A-Za-z0-9]{10,}/g,            // GitHub OAuth
  /ghu_[A-Za-z0-9]{10,}/g,            // GitHub user-to-server
  /ghs_[A-Za-z0-9]{10,}/g,            // GitHub server-to-server
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,    // Slack tokens
  /AIza[A-Za-z0-9_-]{30,}/g,          // Google API keys
  /AKIA[A-Z0-9]{16}/g,                // AWS Access Key ID
  /sk_live_[A-Za-z0-9]{10,}/g,        // Stripe live secret
  /sk_test_[A-Za-z0-9]{10,}/g,        // Stripe test secret
  /hf_[A-Za-z0-9]{10,}/g,             // HuggingFace token
  /gsk_[A-Za-z0-9]{10,}/g,            // Groq Cloud
  /pplx-[A-Za-z0-9]{10,}/g,           // Perplexity
  /fal_[A-Za-z0-9_-]{10,}/g,          // Fal.ai
];

/**
 * 环境变量赋值模式
 */
const ENV_ASSIGN_RE = /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]{0,50})\s*=\s*(['"]?)(\S+)\2/gi;

/**
 * JSON 字段模式
 */
const JSON_FIELD_RE = /("(?:api_?key|token|secret|password|access_token|refresh_token|auth_token|bearer)"\s*:\s*)"([^"]+)"/gi;

/**
 * Authorization header
 */
const AUTH_HEADER_RE = /(Authorization:\s*Bearer\s+)(\S+)/gi;

function maskToken(token: string): string {
  if (token.length >= 18) {
    return token.slice(0, 6) + '****' + token.slice(-4);
  }
  return '****';
}

/**
 * 脱敏文本中的敏感信息
 * 纯函数，输入输出均为 string，无副作用
 */
export function redactSecrets(text: string): string {
  if (!REDACT_ENABLED || !text) return text;

  let result = text;

  // 1. 已知 API Key 前缀
  for (const pattern of PREFIX_PATTERNS) {
    result = result.replace(pattern, (match) => maskToken(match));
  }

  // 2. 环境变量赋值
  result = result.replace(ENV_ASSIGN_RE, (_, key, quote, value) => {
    return `${key}=${quote}${maskToken(value)}${quote}`;
  });

  // 3. JSON 字段
  result = result.replace(JSON_FIELD_RE, (_, keyPart, value) => {
    return `${keyPart}"${maskToken(value)}"`;
  });

  // 4. Authorization header
  result = result.replace(AUTH_HEADER_RE, (_, prefix, token) => {
    return `${prefix}${maskToken(token)}`;
  });

  return result;
}
```

### 2. 修改 `src/utils/logger.ts`

在日志输出前调用 `redactSecrets`：

```typescript
import { redactSecrets } from './redact';

// 在 formatMessage 或输出函数中：
function formatMessage(level: string, message: string, ...args: any[]): string {
  const formatted = util.format(message, ...args);
  return `[${level}] ${timestamp()} ${redactSecrets(formatted)}`;
}
```

### 3. 修改 `src/core/llm-client.ts`

在 catch 块处理错误消息时脱敏：

```typescript
import { redactSecrets } from '../utils/redact';

// 错误处理中：
} catch (error: any) {
  const safeMessage = redactSecrets(error.message ?? String(error));
  logger.error(`LLM API error: ${safeMessage}`);
  throw new Error(safeMessage);
}
```

---

## 测试用例

```typescript
describe('redactSecrets', () => {
  it('masks OpenAI API key', () => {
    const result = redactSecrets('key=sk-1234567890abcdefghij');
    expect(result).not.toContain('sk-1234567890abcdefghij');
    expect(result).toContain('sk-123');  // 保留前6位
  });

  it('masks env assignment', () => {
    const result = redactSecrets('ZHIPU_API_KEY=my-super-secret-key');
    expect(result).toContain('ZHIPU_API_KEY=');
    expect(result).not.toContain('my-super-secret-key');
  });

  it('masks JSON token field', () => {
    const result = redactSecrets('{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}');
    expect(result).toContain('"token"');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('does not alter safe text', () => {
    const text = 'npm install && echo done';
    expect(redactSecrets(text)).toBe(text);
  });

  it('fully masks short tokens (<18 chars)', () => {
    // 短于18字符的 token 完全屏蔽
    const result = redactSecrets('GITHUB_TOKEN=ghp_abc123');
    expect(result).toContain('****');
    expect(result).not.toContain('abc123');
  });
});
```

---

## 注意事项

- `REDACT_ENABLED` 在模块导入时快照环境变量，防止 LLM 在运行时通过 shell export 禁用脱敏
- 正则使用 `/g` 标志，`replace` 每次调用都重新执行（不存在 lastIndex 问题）
- 脱敏是单向操作，对 logger 输出永久生效，不影响内存中的原始数据
- 工具结果（如 `cat .env` 的输出）会经过 logger 脱敏，但原始内容仍传给 LLM（这是预期行为）
