import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LIVE_FEISHU_CASES, type LiveFeishuCase } from './cases'

interface ChatMessage {
  message_id: string
  msg_type: string
  content: string
  sender?: {
    sender_type?: string
  }
}

interface CaseStepResult {
  text: string
  sentMessageId: string
  replyText: string
  passed: boolean
  reason?: string
}

interface CaseResult {
  id: string
  title: string
  automated: boolean
  passed: boolean
  reason?: string
  steps: CaseStepResult[]
}

function parseArgs(argv: string[]): { caseIds?: string[]; focus?: string; list: boolean } {
  const result: { caseIds?: string[]; focus?: string; list: boolean } = { list: false }
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i]
    if (current === '--case' && argv[i + 1]) {
      result.caseIds = argv[++i].split(',').map(value => value.trim()).filter(Boolean)
    } else if (current === '--focus' && argv[i + 1]) {
      result.focus = argv[++i]
    } else if (current === '--list') {
      result.list = true
    }
  }
  return result
}

function runJsonCommand(args: string[]): any {
  const output = execFileSync('lark-cli', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })

  const start = output.indexOf('{')
  if (start === -1) {
    throw new Error(`unexpected CLI output: ${output}`)
  }
  return JSON.parse(output.slice(start))
}

function sendText(chatId: string, text: string): string {
  const payload = runJsonCommand(['im', '+messages-send', '--as', 'user', '--chat-id', chatId, '--text', text])
  if (!payload?.ok || !payload?.data?.message_id) {
    throw new Error(`send failed: ${JSON.stringify(payload)}`)
  }
  return payload.data.message_id as string
}

function listMessages(chatId: string, pageSize = 20): ChatMessage[] {
  const payload = runJsonCommand([
    'im',
    '+chat-messages-list',
    '--as',
    'user',
    '--chat-id',
    chatId,
    '--page-size',
    String(pageSize),
    '--format',
    'json',
  ])

  return (payload?.data?.messages || []) as ChatMessage[]
}

function wait(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

function collectReplies(messages: ChatMessage[], sentMessageId: string): string[] {
  const sentIndex = messages.findIndex(message => message.message_id === sentMessageId)
  const newerMessages = sentIndex >= 0 ? messages.slice(0, sentIndex) : messages
  return newerMessages
    .filter(message => message.sender?.sender_type === 'app')
    .map(message => message.content)
}

function isMeaningfulReply(content: string): boolean {
  const trimmed = content.trim()
  return trimmed !== '' && trimmed !== '💭 正在思考...'
}

async function waitForMeaningfulReply(chatId: string, sentMessageId: string, maxWaitSeconds: number): Promise<string> {
  const startedAt = Date.now()
  let latestReplies: string[] = []

  while (Date.now() - startedAt <= maxWaitSeconds * 1000) {
    latestReplies = collectReplies(listMessages(chatId, 30), sentMessageId)
    const meaningfulReplies = latestReplies.filter(isMeaningfulReply)
    if (meaningfulReplies.length > 0) {
      return meaningfulReplies.join('\n\n')
    }
    await wait(4)
  }

  return latestReplies.join('\n\n')
}

function validateCase(caseDef: LiveFeishuCase, replyText: string): { passed: boolean; reason?: string } {
  if (!replyText.trim()) {
    return { passed: false, reason: 'no app reply captured after wait window' }
  }
  if (caseDef.expectAll && caseDef.expectAll.some(pattern => !pattern.test(replyText))) {
    return { passed: false, reason: `missing expected pattern in reply: ${caseDef.expectAll.map(pattern => pattern.toString()).join(', ')}` }
  }
  if (caseDef.expectAny && !caseDef.expectAny.some(pattern => pattern.test(replyText))) {
    return { passed: false, reason: `reply matched none of expected patterns: ${caseDef.expectAny.map(pattern => pattern.toString()).join(', ')}` }
  }
  if (caseDef.rejectAny && caseDef.rejectAny.some(pattern => pattern.test(replyText))) {
    return { passed: false, reason: `reply contained rejected pattern: ${caseDef.rejectAny.map(pattern => pattern.toString()).join(', ')}` }
  }
  return { passed: true }
}

function selectCases(args: { caseIds?: string[]; focus?: string }): LiveFeishuCase[] {
  if (args.caseIds?.length) {
    return LIVE_FEISHU_CASES.filter(caseDef => args.caseIds?.includes(caseDef.id))
  }
  if (args.focus) {
    return LIVE_FEISHU_CASES.filter(caseDef => caseDef.focus === args.focus)
  }
  return LIVE_FEISHU_CASES.filter(caseDef => caseDef.automated)
}

async function runCase(chatId: string, caseDef: LiveFeishuCase): Promise<CaseResult> {
  if (!caseDef.automated) {
    return {
      id: caseDef.id,
      title: caseDef.title,
      automated: false,
      passed: false,
      reason: caseDef.notes?.join(' ') || 'manual case',
      steps: [],
    }
  }

  const steps: CaseStepResult[] = []
  for (let i = 0; i < caseDef.steps.length; i++) {
    const step = caseDef.steps[i]
    const text = typeof step.text === 'function' ? step.text(i) : step.text
    const sentMessageId = sendText(chatId, text)
    const replyText = await waitForMeaningfulReply(chatId, sentMessageId, step.waitSeconds ?? 30)
    const validation = validateCase(caseDef, replyText)
    steps.push({
      text,
      sentMessageId,
      replyText,
      passed: validation.passed,
      reason: validation.reason,
    })
    if (!validation.passed) {
      return {
        id: caseDef.id,
        title: caseDef.title,
        automated: true,
        passed: false,
        reason: validation.reason,
        steps,
      }
    }
  }

  return {
    id: caseDef.id,
    title: caseDef.title,
    automated: true,
    passed: true,
    steps,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.list) {
    for (const caseDef of LIVE_FEISHU_CASES) {
      console.log(`${caseDef.id}\t${caseDef.automated ? 'automated' : 'manual'}\t${caseDef.title}`)
    }
    return
  }

  const chatId = process.env.CHAT_ID || process.env.XDEV_FEISHU_CHAT_ID
  if (!chatId) {
    throw new Error('CHAT_ID 或 XDEV_FEISHU_CHAT_ID 未设置')
  }

  const selectedCases = selectCases(args)
  if (selectedCases.length === 0) {
    throw new Error('没有匹配的 live Feishu 用例')
  }

  const results: CaseResult[] = []
  for (const caseDef of selectedCases) {
    console.log(`\n[RUN] ${caseDef.id} ${caseDef.title}`)
    const result = await runCase(chatId, caseDef)
    results.push(result)
    console.log(`[${result.passed ? 'PASS' : 'FAIL'}] ${result.id} ${result.title}${result.reason ? ` - ${result.reason}` : ''}`)
  }

  const outDir = process.env.XDEV_LIVE_TEST_OUTDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'xdev-live-feishu-'))
  fs.mkdirSync(outDir, { recursive: true })
  const summaryPath = path.join(outDir, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2))

  console.log(`\nResults saved to ${summaryPath}`)

  const failed = results.filter(result => !result.passed && result.automated)
  if (failed.length > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
