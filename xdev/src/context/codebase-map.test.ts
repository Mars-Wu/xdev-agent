import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateCodebaseSnapshot,
  generateOrLoadCodebaseSnapshot,
  getCodebaseSnapshotArtifactPaths,
  loadCodebaseSnapshot,
  renderCodebaseSnapshotMarkdown,
  saveCodebaseSnapshot,
} from './codebase-map'

const tempDirs: string[] = []

async function createTempRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-map-'))
  tempDirs.push(root)

  await fs.mkdir(path.join(root, 'src', 'tools'), { recursive: true })
  await fs.mkdir(path.join(root, 'tests'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'sample-repo',
      scripts: {
        build: 'tsc',
        test: 'vitest run',
        dev: 'vite',
      },
      dependencies: {
        express: '^5.0.0',
      },
      devDependencies: {
        typescript: '^5.0.0',
        vitest: '^4.0.0',
      },
    }, null, 2),
    'utf-8',
  )
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}', 'utf-8')
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const app = true\n', 'utf-8')
  await fs.writeFile(path.join(root, 'src', 'tools', 'map-tool.ts'), 'export const map = true\n', 'utf-8')
  await fs.writeFile(path.join(root, 'tests', 'map.test.ts'), 'export {}\n', 'utf-8')

  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root })

  return root
}

describe('codebase-map', () => {
  afterEach(async () => {
    delete process.env.XDEV_HOME
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  it('generates a snapshot with tech stack, modules, and commands', async () => {
    const repoRoot = await createTempRepo()
    const snapshot = await generateCodebaseSnapshot(repoRoot, { maxTreeLines: 20 })

    expect(snapshot.rootPath).toBe(repoRoot)
    expect(snapshot.techStack.languages.some(item => item.name === 'TypeScript')).toBe(true)
    expect(snapshot.techStack.tests).toContain('Vitest')
    expect(snapshot.techStack.backend).toContain('Express')
    expect(snapshot.commands.build).toContain('npm run build')
    expect(snapshot.commands.test).toContain('npm test')
    expect(snapshot.coreModules.some(module => module.path === 'src/tools')).toBe(true)
    expect(snapshot.testFiles.count).toBe(1)
    expect(snapshot.directoryTree.lines.length).toBeGreaterThan(0)

    const markdown = renderCodebaseSnapshotMarkdown(snapshot)
    expect(markdown).toContain('# 代码库快照')
    expect(markdown).toContain('## 核心模块')
    expect(markdown).toContain('src/tools')
  })

  it('saves and loads snapshot artifacts under XDEV_HOME cache', async () => {
    const repoRoot = await createTempRepo()
    const xdevHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-home-'))
    tempDirs.push(xdevHome)
    process.env.XDEV_HOME = xdevHome

    const snapshot = await generateCodebaseSnapshot(repoRoot)
    const saved = await saveCodebaseSnapshot(snapshot)

    expect(saved.jsonPath.startsWith(path.join(xdevHome, 'cache', 'codebase-maps'))).toBe(true)
    const loaded = await loadCodebaseSnapshot(repoRoot)
    expect(loaded?.rootPath).toBe(repoRoot)

    const paths = getCodebaseSnapshotArtifactPaths(repoRoot)
    expect(paths.jsonPath).toBe(saved.jsonPath)
    expect(paths.markdownPath).toBe(saved.markdownPath)
  })

  it('reuses saved snapshot when git fingerprint is unchanged', async () => {
    const repoRoot = await createTempRepo()
    const xdevHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-home-'))
    tempDirs.push(xdevHome)
    process.env.XDEV_HOME = xdevHome

    const first = await generateOrLoadCodebaseSnapshot(repoRoot)
    expect(first.cacheHit).toBe(false)
    await saveCodebaseSnapshot(first.snapshot)

    const second = await generateOrLoadCodebaseSnapshot(repoRoot)
    expect(second.cacheHit).toBe(true)
    expect(second.snapshot.sourceFingerprint).toBe(first.snapshot.sourceFingerprint)
  })
})
