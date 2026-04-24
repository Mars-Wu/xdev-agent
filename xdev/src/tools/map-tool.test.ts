import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMapTool } from './map-tool'

const tempDirs: string[] = []

async function createTempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-map-tool-'))
  tempDirs.push(root)

  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'sample-repo',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { vitest: '^4.0.0', typescript: '^5.0.0' },
    }),
    'utf-8',
  )
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const main = 1\n', 'utf-8')

  return root
}

describe('map-tool', () => {
  afterEach(async () => {
    delete process.env.XDEV_HOME
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('generates and saves a snapshot', async () => {
    const repoRoot = await createTempRepo()
    const xdevHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-home-'))
    tempDirs.push(xdevHome)
    process.env.XDEV_HOME = xdevHome

    const tool = createMapTool()
    const result = await tool.execute({ action: 'generate', path: repoRoot, format: 'summary' })

    expect(result.success).toBe(true)
    expect(result.output).toContain('代码库摘要')
    expect(result.data?.saved).toBe(true)
  })

  it('reads a previously saved snapshot', async () => {
    const repoRoot = await createTempRepo()
    const xdevHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-home-'))
    tempDirs.push(xdevHome)
    process.env.XDEV_HOME = xdevHome

    const tool = createMapTool()
    await tool.execute({ action: 'generate', path: repoRoot })
    const result = await tool.execute({ action: 'get', path: repoRoot, format: 'summary' })

    expect(result.success).toBe(true)
    expect(result.output).toContain(repoRoot)
  })
})

