// src/core/prompt-cache.ts
// Anthropic Prompt Caching (system_and_3 策略) — 参考 Hermes agent/prompt_caching.py
// GLM/Zhipu 不支持 cache_control，通过 supportsPromptCaching 能力标志控制

export interface CacheControl {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

const CACHE_MARKER: CacheControl = { type: 'ephemeral' }

/**
 * 在单条消息的最后一个 content block 上注入 cache_control 断点
 */
function applyCacheMarker(msg: Record<string, unknown>, marker: CacheControl): void {
  const content = msg.content

  if (content === null || content === undefined || content === '') {
    msg.cache_control = marker
    return
  }

  if (typeof content === 'string') {
    msg.content = [{ type: 'text', text: content, cache_control: marker }]
    return
  }

  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1] as Record<string, unknown>
    if (last && typeof last === 'object') {
      last.cache_control = marker
    }
  }
}

/**
 * 应用 system_and_3 缓存策略：最多4个 cache_control 断点
 *   - 断点1：system prompt（最稳定，命中率最高）
 *   - 断点2-4：最近3条非 system 消息（滚动窗口）
 *
 * 返回深拷贝，不修改原始消息数组
 */
export function applyPromptCaching(
  messages: Record<string, unknown>[],
  cacheTtl: '5m' | '1h' = '5m',
): Record<string, unknown>[] {
  if (!messages || messages.length === 0) return messages

  const result: Record<string, unknown>[] = JSON.parse(JSON.stringify(messages))
  const marker: CacheControl = { type: 'ephemeral' }
  if (cacheTtl === '1h') marker.ttl = '1h'

  let breakpointsUsed = 0

  // 断点1：system prompt
  if (result[0]?.role === 'system') {
    applyCacheMarker(result[0], marker)
    breakpointsUsed++
  }

  // 断点2-4：最近的非 system 消息
  const remaining = 4 - breakpointsUsed
  const nonSysIndices = result
    .map((_, i) => i)
    .filter((i) => result[i]?.role !== 'system')

  for (const idx of nonSysIndices.slice(-remaining)) {
    applyCacheMarker(result[idx], marker)
  }

  return result
}
