#!/usr/bin/env node

import { runDoctor, runSmokeCheck, renderDoctorResult, renderSmokeCheckResult } from './ops/doctor'
import { exportStatus, renderExportStatus } from './ops/export-status'

type Command = 'doctor' | 'smoke-check' | 'export-status' | 'help'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = (args[0] as Command | undefined) || 'help'
  const options = parseOptions(args.slice(1))

  switch (command) {
    case 'doctor': {
      const result = await runDoctor({
        envFile: options['env-file'],
        healthUrl: options['health-url'],
      })
      printOutput(result, renderDoctorResult(result), options.json === 'true')
      process.exit(result.ok ? 0 : 1)
      return
    }

    case 'smoke-check': {
      const result = await runSmokeCheck({
        envFile: options['env-file'],
        healthUrl: options['health-url'],
        projectPath: options['project-path'],
      })
      printOutput(result, renderSmokeCheckResult(result), options.json === 'true')
      process.exit(result.ok ? 0 : 1)
      return
    }

    case 'export-status': {
      const result = await exportStatus({
        projectPath: options['project-path'],
      })
      printOutput(result, renderExportStatus(result), options.json === 'true')
      process.exit(0)
      return
    }

    case 'help':
    default:
      console.log(`艾克斯 CLI

用法:
  xdev doctor [--env-file /etc/xdev/environment] [--health-url http://127.0.0.1:8081/health] [--json]
  xdev smoke-check [--project-path /path/to/project] [--env-file /etc/xdev/environment] [--json]
  xdev export-status [--project-path /path/to/project] [--json]
`)
      process.exit(command === 'help' ? 0 : 1)
  }
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    const next = args[index + 1]
    if (!next || next.startsWith('--')) {
      options[key] = 'true'
      continue
    }

    options[key] = next
    index += 1
  }
  return options
}

function printOutput(value: unknown, text: string, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  console.log(text)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
