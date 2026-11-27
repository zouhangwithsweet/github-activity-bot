import { githubTokens, hasNextPage, isRepositoryName, readGitHubRest } from './github.ts'

type PullRequestPreview =
  | { kind: 'ready'; origin: URL }
  | { kind: 'missing' | 'pending' | 'unavailable' | 'ambiguous' }

export type PullRequestPreviewQuery = (
  repository: string,
  headSha: string,
  signal?: AbortSignal,
) => Promise<PullRequestPreview>

interface Deployment {
  id: number
  sha: string
  environment?: string
  original_environment?: string
  production_environment?: boolean
}

interface DeploymentStatus {
  id: number
  created_at: string
  state: string
  environment?: string
  environment_url?: string
}

const maxDeployments = 12
const maxStatuses = 20

function isProduction(environment: string | undefined) {
  return typeof environment === 'string' && /^production\b/i.test(environment.trim())
}

function vercelPreviewOrigin(value: string | undefined) {
  // Vercel commit URLs use <project>-<9-character hash>-<scope>.vercel.app.
  if (typeof value !== 'string' || value.length > 83) return null
  const match =
    /^https:\/\/([a-z0-9][a-z0-9-]*-[a-z0-9]{9}-[a-z0-9-]*[a-z0-9])\.vercel\.app\/?$/i.exec(value)
  if (!match || match[0] !== value) return null
  const label = match[1].toLowerCase()
  if (label.length > 63 || label.includes('-git-')) return null
  return new URL(`https://${label}.vercel.app`)
}

async function readLatestDeploymentStatus(
  path: string,
  tokens: string[],
  request: typeof fetch,
): Promise<PullRequestPreview> {
  const response = await readGitHubRest(`${path}?per_page=${maxStatuses}`, tokens, request)
  if (!response || hasNextPage(response)) return { kind: 'unavailable' }

  const statuses = (await response.json()) as DeploymentStatus[]
  if (!Array.isArray(statuses) || statuses.length > maxStatuses) return { kind: 'unavailable' }
  if (!statuses.length) return { kind: 'pending' }

  const dated = statuses.map((status) => ({ status, createdAt: Date.parse(status.created_at) }))
  if (
    dated.some(
      ({ status, createdAt }) => !Number.isSafeInteger(status.id) || Number.isNaN(createdAt),
    )
  ) {
    return { kind: 'unavailable' }
  }
  const { status } = dated.sort((a, b) => b.createdAt - a.createdAt || b.status.id - a.status.id)[0]
  if (isProduction(status.environment)) return { kind: 'missing' }

  switch (status.state) {
    case 'success': {
      const origin = vercelPreviewOrigin(status.environment_url)
      return origin ? { kind: 'ready', origin } : { kind: 'missing' }
    }
    case 'pending':
    case 'in_progress':
    case 'queued':
      return { kind: 'pending' }
    case 'failure':
    case 'error':
    case 'inactive':
      return { kind: 'missing' }
    default:
      return { kind: 'unavailable' }
  }
}

export function createPullRequestPreviewQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestPreviewQuery {
  const tokens = githubTokens(env)

  return async (repository, headSha, callerSignal) => {
    if (!tokens.length || !isRepositoryName(repository) || !/^[a-f0-9]{40}$/i.test(headSha)) {
      return { kind: 'unavailable' }
    }

    const timeout = AbortSignal.timeout(8_000)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    const requestGitHub: typeof fetch = (url, options) => {
      signal.throwIfAborted()
      return request(url, { ...options, signal, redirect: 'error' })
    }

    const sha = headSha.toLowerCase()
    const path = `/repos/${repository}/deployments`

    try {
      signal.throwIfAborted()
      const response = await readGitHubRest(
        `${path}?sha=${sha}&per_page=${maxDeployments}`,
        tokens,
        requestGitHub,
      )
      if (!response || hasNextPage(response)) return { kind: 'unavailable' }

      const deployments = (await response.json()) as Deployment[]
      if (!Array.isArray(deployments) || deployments.length > maxDeployments) {
        return { kind: 'unavailable' }
      }
      const candidates = deployments.filter(
        (deployment) =>
          deployment.sha.toLowerCase() === sha &&
          deployment.production_environment === false &&
          !isProduction(deployment.original_environment) &&
          !isProduction(deployment.environment),
      )
      if (candidates.some(({ id }) => !Number.isSafeInteger(id) || id < 1)) {
        return { kind: 'unavailable' }
      }

      const ids = new Set(candidates.map(({ id }) => id))
      signal.throwIfAborted()
      const results = await Promise.all(
        [...ids].map((id) =>
          readLatestDeploymentStatus(`${path}/${id}/statuses`, tokens, requestGitHub),
        ),
      )
      signal.throwIfAborted()

      const origins = new Map<string, URL>()
      for (const result of results) {
        if (result.kind === 'ready') origins.set(result.origin.origin, result.origin)
      }
      if (origins.size > 1) return { kind: 'ambiguous' }
      if (results.some(({ kind }) => kind === 'unavailable')) return { kind: 'unavailable' }
      const origin = origins.values().next().value
      if (origin) return { kind: 'ready', origin }
      return results.some(({ kind }) => kind === 'pending')
        ? { kind: 'pending' }
        : { kind: 'missing' }
    } catch {
      return { kind: 'unavailable' }
    }
  }
}
