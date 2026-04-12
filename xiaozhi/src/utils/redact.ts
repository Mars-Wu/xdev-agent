// src/utils/redact.ts
// 日志脱敏 — 参考 Hermes agent/redact.py
// 在模块导入时快照环境变量，防止 LLM 在运行时通过 shell export 禁用脱敏

const REDACT_ENABLED = !['0', 'false', 'no', 'off'].includes(
  (process.env.XIAOZHI_REDACT_SECRETS ?? '').toLowerCase(),
)

/**
 * 已知 API Key 前缀正则（/g 标志——每次 replace 调用重新执行，无 lastIndex 问题）
 */
const PREFIX_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g,           // OpenAI / Anthropic / OpenRouter
  /ghp_[A-Za-z0-9]{10,}/g,            // GitHub PAT classic
  /github_pat_[A-Za-z0-9_]{10,}/g,    // GitHub PAT fine-grained
  /gho_[A-Za-z0-9]{10,}/g,            // GitHub OAuth
  /ghu_[A-Za-z0-9]{10,}/g,            // GitHub user-to-server token
  /ghs_[A-Za-z0-9]{10,}/g,            // GitHub server-to-server token
  /ghr_[A-Za-z0-9]{10,}/g,            // GitHub refresh token
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,    // Slack tokens
  /AIza[A-Za-z0-9_-]{30,}/g,          // Google API keys
  /pplx-[A-Za-z0-9]{10,}/g,           // Perplexity
  /fal_[A-Za-z0-9_-]{10,}/g,          // Fal.ai
  /AKIA[A-Z0-9]{16}/g,                // AWS Access Key ID
  /sk_live_[A-Za-z0-9]{10,}/g,        // Stripe live secret
  /sk_test_[A-Za-z0-9]{10,}/g,        // Stripe test secret
  /SG\.[A-Za-z0-9_-]{10,}/g,          // SendGrid
  /hf_[A-Za-z0-9]{10,}/g,             // HuggingFace
  /r8_[A-Za-z0-9]{10,}/g,             // Replicate
  /npm_[A-Za-z0-9]{10,}/g,            // npm access token
  /gsk_[A-Za-z0-9]{10,}/g,            // Groq Cloud
  /tvly-[A-Za-z0-9]{10,}/g,           // Tavily
  /exa_[A-Za-z0-9]{10,}/g,            // Exa search
]

// 环境变量赋值：KEY=value，KEY 含敏感词
const ENV_ASSIGN_RE =
  /([A-Z0-9_]{0,50}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]{0,50})\s*=\s*(['"]?)(\S{6,})\2/gi

// JSON 字段："apiKey": "value"
const JSON_FIELD_RE =
  /("(?:api_?key|token|secret|password|access_token|refresh_token|auth_token|bearer)"\s*:\s*)"([^"]{6,})"/gi

// Authorization header
const AUTH_HEADER_RE = /(Authorization:\s*Bearer\s+)(\S+)/gi

function maskToken(token: string): string {
  if (token.length >= 18) {
    return token.slice(0, 6) + '****' + token.slice(-4)
  }
  return '****'
}

/**
 * 脱敏文本中的敏感信息
 * 纯函数，无副作用，输入输出均为 string
 */
export function redactSecrets(text: string): string {
  if (!REDACT_ENABLED || !text) return text

  let result = text

  // 1. 已知 API Key 前缀
  for (const pattern of PREFIX_PATTERNS) {
    result = result.replace(pattern, (match) => maskToken(match))
  }

  // 2. 环境变量赋值
  result = result.replace(
    ENV_ASSIGN_RE,
    (_, key: string, quote: string, value: string) => `${key}=${quote}${maskToken(value)}${quote}`,
  )

  // 3. JSON 敏感字段
  result = result.replace(
    JSON_FIELD_RE,
    (_, keyPart: string, value: string) => `${keyPart}"${maskToken(value)}"`,
  )

  // 4. Authorization header
  result = result.replace(
    AUTH_HEADER_RE,
    (_, prefix: string, token: string) => `${prefix}${maskToken(token)}`,
  )

  return result
}
