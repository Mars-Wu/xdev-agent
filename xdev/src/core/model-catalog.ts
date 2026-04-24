// src/core/model-catalog.ts
// 模型目录：统一维护模型定义、别名、能力、成本和推荐角色

export type ModelProvider = 'glm'
export type ModelTransport = 'anthropic-messages' | 'native-chat-completions'

export interface TextModelCatalogEntry {
  kind: 'text'
  id: string
  name: string
  provider: ModelProvider
  aliases: string[]
  transports: ModelTransport[]
  contextWindow: number
  maxOutput: number
  costPerMtok: {
    input: number
    output: number
  }
  isFree: boolean
  supportsThinking: boolean
  supportsVision: boolean
  supportsTools: boolean
  supportsPromptCaching: boolean
  maxToolCalls: number
  defaultRoles?: Array<'main' | 'coder' | 'router' | 'selector' | 'background' | 'auxiliary'>
}

export interface VisionModelCatalogEntry {
  kind: 'vision'
  id: string
  name: string
  provider: ModelProvider
  aliases: string[]
  transports: ModelTransport[]
  supportsThinking: boolean
  defaultRoles?: Array<'vision'>
}

export type ModelCatalogEntry = TextModelCatalogEntry | VisionModelCatalogEntry

export const DEFAULT_MAIN_MODEL = 'glm-5-turbo'
export const DEFAULT_FAST_MODEL = 'glm-4.7-flash'
export const DEFAULT_AUX_MODEL = DEFAULT_FAST_MODEL
export const DEFAULT_CODER_MODEL = 'glm-5'
export const DEFAULT_VISION_MODEL = 'glm-5v-turbo'

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    kind: 'text',
    id: 'glm-4-flash',
    name: 'GLM-4-Flash',
    provider: 'glm',
    aliases: ['4-flash', 'g4f', 'glm-4-flash', 'glm-4-flash-250414'],
    transports: ['anthropic-messages'],
    contextWindow: 128_000,
    maxOutput: 4096,
    costPerMtok: { input: 0, output: 0 },
    isFree: true,
    supportsThinking: false,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 64,
  },
  {
    kind: 'text',
    id: 'glm-4.7-flash',
    name: 'GLM-4.7-Flash',
    provider: 'glm',
    aliases: ['flash', '4.7-flash', 'g4.7f', 'glm-4.7-flash'],
    transports: ['anthropic-messages'],
    contextWindow: 200_000,
    maxOutput: 128_000,
    costPerMtok: { input: 0, output: 0 },
    isFree: true,
    supportsThinking: true,
    supportsVision: false,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 128,
    defaultRoles: ['router', 'selector', 'background', 'auxiliary'],
  },
  {
    kind: 'text',
    id: 'glm-5',
    name: 'GLM-5',
    provider: 'glm',
    aliases: ['glm5', 'g5', 'glm-5'],
    transports: ['anthropic-messages', 'native-chat-completions'],
    contextWindow: 200_000,
    maxOutput: 128_000,
    costPerMtok: { input: 1, output: 1 },
    isFree: false,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 700,
    defaultRoles: ['coder'],
  },
  {
    kind: 'text',
    id: 'glm-5.1',
    name: 'GLM-5.1',
    provider: 'glm',
    aliases: ['glm51', 'g51', 'glm-5.1'],
    transports: ['anthropic-messages', 'native-chat-completions'],
    contextWindow: 200_000,
    maxOutput: 128_000,
    costPerMtok: { input: 1, output: 1 },
    isFree: false,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 700,
  },
  {
    kind: 'text',
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'glm',
    aliases: ['turbo', 'g5t', 'glm-5-turbo'],
    transports: ['anthropic-messages', 'native-chat-completions'],
    contextWindow: 200_000,
    maxOutput: 128_000,
    costPerMtok: { input: 1, output: 1 },
    isFree: false,
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    supportsPromptCaching: false,
    maxToolCalls: 700,
    defaultRoles: ['main'],
  },
  {
    kind: 'vision',
    id: 'glm-4v-flash',
    name: 'GLM-4V-Flash',
    provider: 'glm',
    aliases: ['4v-flash', 'g4vf', 'vision-flash', 'glm-4v-flash'],
    transports: ['native-chat-completions'],
    supportsThinking: false,
  },
  {
    kind: 'vision',
    id: 'glm-5v-turbo',
    name: 'GLM-5V-Turbo',
    provider: 'glm',
    aliases: ['5v-turbo', 'glm-5v-turbo'],
    transports: ['native-chat-completions'],
    supportsThinking: true,
    defaultRoles: ['vision'],
  },
]

interface FindCatalogModelOptions {
  kind?: 'text' | 'vision'
  transport?: ModelTransport
}

function filterCatalog({ kind, transport }: FindCatalogModelOptions): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((entry) => {
    if (kind && entry.kind !== kind) return false
    if (transport && !entry.transports.includes(transport)) return false
    return true
  })
}

function findByIdOrAlias(
  input: string,
  candidates: ModelCatalogEntry[],
): ModelCatalogEntry | null {
  const directMatch = candidates.find((entry) => entry.id === input)
  if (directMatch) return directMatch

  const lower = input.toLowerCase()
  return candidates.find((entry) => entry.aliases.includes(lower)) || null
}

export function listTextCatalogModels(options: {
  transport?: ModelTransport
} = {}): TextModelCatalogEntry[] {
  return filterCatalog({ kind: 'text', transport: options.transport }) as TextModelCatalogEntry[]
}

export function listVisionCatalogModels(options: {
  transport?: ModelTransport
} = {}): VisionModelCatalogEntry[] {
  return filterCatalog({ kind: 'vision', transport: options.transport }) as VisionModelCatalogEntry[]
}

export function getModelCatalogEntry(modelId: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === modelId)
}

export function findCatalogModel(
  input: string,
  options: FindCatalogModelOptions = {},
): ModelCatalogEntry | null {
  const normalized = input.trim()
  if (!normalized) return null

  const candidates = filterCatalog(options)
  const exact = findByIdOrAlias(normalized, candidates)
  if (exact) return exact

  const lower = normalized.toLowerCase()

  if (options.kind === 'text' && (lower.includes('5v') || lower.includes('4v') || lower.includes('vision'))) {
    return null
  }

  if (options.kind !== 'text' && lower.includes('5v')) {
    return candidates.find((entry) => entry.id === 'glm-5v-turbo') || null
  }

  if (options.kind !== 'text' && lower.includes('4v')) {
    return candidates.find((entry) => entry.id === 'glm-4v-flash') || null
  }

  if (lower.includes('5.1')) {
    return candidates.find((entry) => entry.id === 'glm-5.1') || null
  }

  if ((lower.includes('4.7') || lower.includes('47')) && lower.includes('flash')) {
    return candidates.find((entry) => entry.id === 'glm-4.7-flash') || null
  }

  if (lower.includes('4-flash') || (lower.includes('4') && lower.includes('flash') && !lower.includes('4.7') && !lower.includes('47'))) {
    return candidates.find((entry) => entry.id === 'glm-4-flash') || null
  }

  if (lower.includes('glm') && lower.includes('5')) {
    if (lower.includes('turbo')) {
      return candidates.find((entry) => entry.id === 'glm-5-turbo') || null
    }
    return candidates.find((entry) => entry.id === 'glm-5') || null
  }

  return null
}

export function resolveCatalogModelId(
  input: string,
  options: FindCatalogModelOptions & { fallback?: string } = {},
): string {
  const match = findCatalogModel(input, options)
  if (match) return match.id
  return options.fallback || DEFAULT_MAIN_MODEL
}

export function getDefaultVisionModelId(override?: string): string {
  return resolveCatalogModelId(
    override || DEFAULT_VISION_MODEL,
    { kind: 'vision', transport: 'native-chat-completions', fallback: DEFAULT_VISION_MODEL },
  )
}
