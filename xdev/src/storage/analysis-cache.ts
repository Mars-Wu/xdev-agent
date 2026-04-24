import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { PATHS } from '../config'

export interface AnalysisCacheState {
  version: 1
  key: string
  fingerprint: string
  updatedAt: string
  artifacts: string[]
  metadata?: Record<string, unknown>
}

export interface CachedArtifactInput {
  path: string
  content: string
}

export interface WriteCachedArtifactsResult {
  cacheHit: boolean
  statePath: string
}

export class AnalysisCache {
  constructor(private readonly baseDir: string = path.join(PATHS.CACHE_DIR, 'analysis-cache')) {}

  async loadState(namespace: string, key: string): Promise<AnalysisCacheState | null> {
    try {
      const raw = await fs.readFile(this.getStatePath(namespace, key), 'utf-8')
      return JSON.parse(raw) as AnalysisCacheState
    } catch {
      return null
    }
  }

  async writeArtifacts(
    namespace: string,
    key: string,
    fingerprint: string,
    artifacts: CachedArtifactInput[],
    metadata?: Record<string, unknown>,
  ): Promise<WriteCachedArtifactsResult> {
    const statePath = this.getStatePath(namespace, key)
    const existing = await this.loadState(namespace, key)
    const artifactPaths = artifacts.map(item => item.path)

    if (
      existing?.fingerprint === fingerprint &&
      await this.allArtifactsExist(artifactPaths)
    ) {
      return { cacheHit: true, statePath }
    }

    await Promise.all([
      fs.mkdir(path.dirname(statePath), { recursive: true }),
      ...artifacts.map(item => fs.mkdir(path.dirname(item.path), { recursive: true })),
    ])

    await Promise.all([
      ...artifacts.map(item => fs.writeFile(item.path, item.content, 'utf-8')),
      fs.writeFile(
        statePath,
        JSON.stringify(
          {
            version: 1,
            key,
            fingerprint,
            updatedAt: new Date().toISOString(),
            artifacts: artifactPaths,
            metadata,
          } satisfies AnalysisCacheState,
          null,
          2,
        ),
        'utf-8',
      ),
    ])

    return { cacheHit: false, statePath }
  }

  private getStatePath(namespace: string, key: string): string {
    const keyHash = createHash('sha1').update(key).digest('hex').slice(0, 12)
    const safeNamespace = sanitizeSegment(namespace)
    const safeKey = sanitizeSegment(path.basename(key)) || 'artifact'
    return path.join(this.baseDir, safeNamespace, `${safeKey}-${keyHash}.json`)
  }

  private async allArtifactsExist(pathsToCheck: string[]): Promise<boolean> {
    const checks = await Promise.all(
      pathsToCheck.map(async filePath => {
        try {
          await fs.access(filePath)
          return true
        } catch {
          return false
        }
      }),
    )
    return checks.every(Boolean)
  }
}

export function createAnalysisFingerprint(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha1').update(raw).digest('hex')
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}
