import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs/promises'
import { resolveTextApiConfig } from '../src/core/model-config'

type BenchmarkTarget = {
  label: string
  provider: 'glm' | 'deepseek'
  model: string
}

type BenchmarkPrompt = {
  name: string
  system: string
  user: string
}

type BenchmarkResult = {
  target: BenchmarkTarget
  prompt: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  content: string
  thinking: string | null
}

const TARGETS: BenchmarkTarget[] = [
  { label: 'GLM-5.1', provider: 'glm', model: 'glm-5.1' },
  { label: 'DeepSeek-V4-Pro', provider: 'deepseek', model: 'deepseek-v4-pro' },
]

const DEFAULT_PROMPTS: BenchmarkPrompt[] = [
  {
    name: 'single-session-multi-topic',
    system: 'You are evaluating an assistant for single-session, multi-topic collaboration in Feishu. Be structured and concise.',
    user: [
      'A user says in one conversation:',
      '1. Summarize today\'s deployment issue in one sentence.',
      '2. Extract the next three follow-up actions.',
      '3. Point out which details belong to a separate topic that should not be mixed into the deployment summary.',
      '',
      'Conversation:',
      '- The service restart failed because the environment file still referenced an old API key.',
      '- We also need to prepare a README update for open-source publication.',
      '- After fixing the environment file, the service became healthy again.',
      '- There is a request to benchmark DeepSeek against GLM next week.',
    ].join('\n'),
  },
  {
    name: 'tool-planning',
    system: 'You are evaluating a coding agent model. Prefer exact, implementation-oriented reasoning.',
    user: [
      'Design a safe implementation plan for adding a configurable DeepSeek provider to an existing TypeScript agent runtime.',
      'The runtime already supports GLM through an Anthropic-compatible endpoint, tool calls, and a separate vision pipeline.',
      'Focus on migration order, compatibility risks, and how to preserve existing behavior.',
    ].join('\n'),
  },
]

function getPrompts(): BenchmarkPrompt[] {
  if (process.env.XDEV_BENCHMARK_PROMPT) {
    return [{
      name: 'custom',
      system: 'You are benchmarking text model quality and latency. Answer directly.',
      user: process.env.XDEV_BENCHMARK_PROMPT,
    }]
  }
  return DEFAULT_PROMPTS
}

function applyThinkingConfig(
  target: BenchmarkTarget,
  request: Record<string, unknown>,
): void {
  if (target.provider === 'deepseek') {
    request.thinking = { type: 'enabled' }
    request.output_config = { effort: 'high' }
    return
  }

  request.enable_thinking = true
}

function extractContent(response: Anthropic.Message): { content: string; thinking: string | null } {
  let content = ''
  let thinking: string | null = null

  for (const block of response.content) {
    if (block.type === 'thinking') {
      const thinkingText = (block as unknown as { thinking?: string }).thinking || ''
      thinking = [thinking, thinkingText].filter(Boolean).join('\n').trim() || null
      continue
    }

    if (block.type === 'text') {
      content += block.text
    }
  }

  return { content: content.trim(), thinking }
}

async function runSingleBenchmark(
  target: BenchmarkTarget,
  prompt: BenchmarkPrompt,
): Promise<BenchmarkResult> {
  const apiConfig = resolveTextApiConfig({ provider: target.provider, model: target.model })
  if (!apiConfig.apiKey) {
    throw new Error(`Missing API key for ${target.label}. Configure ${target.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ZHIPU_API_KEY'}.`)
  }

  const client = new Anthropic({
    apiKey: apiConfig.apiKey,
    baseURL: apiConfig.baseURL,
  })

  const request: Record<string, unknown> = {
    model: target.model,
    max_tokens: 2000,
    system: prompt.system,
    messages: [
      {
        role: 'user',
        content: prompt.user,
      },
    ],
  }
  applyThinkingConfig(target, request)

  const started = Date.now()
  const response = await client.messages.create(request as Anthropic.MessageCreateParamsNonStreaming)
  const latencyMs = Date.now() - started
  const parsed = extractContent(response)

  return {
    target,
    prompt: prompt.name,
    latencyMs,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    content: parsed.content,
    thinking: parsed.thinking,
  }
}

function renderSummary(results: BenchmarkResult[]): string {
  const lines: string[] = []
  lines.push('# Model benchmark')
  lines.push('')

  for (const result of results) {
    lines.push(`## ${result.prompt} — ${result.target.label}`)
    lines.push(`- provider: ${result.target.provider}`)
    lines.push(`- model: ${result.target.model}`)
    lines.push(`- latency_ms: ${result.latencyMs}`)
    lines.push(`- input_tokens: ${result.inputTokens}`)
    lines.push(`- output_tokens: ${result.outputTokens}`)
    lines.push('')
    lines.push('### response')
    lines.push(result.content || '(empty)')
    if (result.thinking) {
      lines.push('')
      lines.push('### thinking')
      lines.push(result.thinking)
    }
    lines.push('')
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const prompts = getPrompts()
  const results: BenchmarkResult[] = []

  for (const prompt of prompts) {
    for (const target of TARGETS) {
      process.stdout.write(`Running ${target.label} on ${prompt.name}...\n`)
      const result = await runSingleBenchmark(target, prompt)
      results.push(result)
      process.stdout.write(
        `  done: latency=${result.latencyMs}ms, input=${result.inputTokens}, output=${result.outputTokens}\n`,
      )
    }
  }

  const summary = renderSummary(results)
  console.log(`\n${summary}`)

  const outputPath = process.env.XDEV_BENCHMARK_OUT
  if (outputPath) {
    await fs.writeFile(outputPath, `${summary}\n`, 'utf-8')
    console.log(`\nSaved benchmark report to ${outputPath}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
