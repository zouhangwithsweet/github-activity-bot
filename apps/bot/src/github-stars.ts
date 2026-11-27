import { GitHubActivityPollError, retryDelay } from './github-activity.ts'
import { githubTokens, isRepositoryName } from './github.ts'

export type StarRepositorySource = 'watched' | 'accessible'

interface StarRepository {
  repository: string
  starCount?: number
}

export interface GitHubStarQueries {
  listRepositories(signal?: AbortSignal): Promise<StarRepository[]>
  readStarCount(repository: string, signal?: AbortSignal): Promise<number>
}

interface RepositoryMetadata {
  full_name: string
  stargazers_count: number
}

const githubOrigin = 'https://api.github.com'
const maxPages = 20
const pageSize = 100

function validStarCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function pollSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function nextRepositoryPage(response: Response, path: string) {
  const link = /<([^>]+)>\s*;\s*rel="next"/i.exec(response.headers.get('link') ?? '')
  if (!link) return
  const url = URL.parse(link[1], githubOrigin)
  if (
    url?.origin !== githubOrigin ||
    url.pathname !== path ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new GitHubActivityPollError('GitHub returned an invalid Star repository pagination link.')
  }
  return url.href
}

export function createGitHubStarQueries(
  config: { source?: StarRepositorySource; repositories: readonly string[] },
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): GitHubStarQueries | undefined {
  const [primary, secondary] = githubTokens(env)
  if (!primary) return
  const source = config.source
  const explicit = config.repositories.map((repository) => repository.trim())
  if (explicit.some((repository) => !isRepositoryName(repository))) {
    throw new GitHubActivityPollError('Star monitoring repositories must use owner/repo names.')
  }
  let secondaryVerified = false

  async function readJSON<T>(
    url: string,
    token: string,
    signal: AbortSignal,
    allowedStatuses: readonly number[] = [],
  ) {
    let response: Response
    try {
      signal.throwIfAborted()
      const headers = new Headers({
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'github-activity-bot',
      })
      response = await request(url, {
        headers,
        method: 'GET',
        redirect: 'error',
        signal,
      })
    } catch {
      throw new GitHubActivityPollError('GitHub Star monitoring request failed or was canceled.')
    }

    if (!response.ok) {
      const retryAfterMs = retryDelay(response.headers)
      const rateLimited =
        response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0'
      void response.body?.cancel().catch(() => undefined)
      if (rateLimited || retryAfterMs !== undefined) {
        throw new GitHubActivityPollError(
          'GitHub Star monitoring was rate-limited.',
          retryAfterMs ?? 60_000,
        )
      }
      if (allowedStatuses.includes(response.status)) return
      throw new GitHubActivityPollError(`GitHub Star monitoring returned HTTP ${response.status}.`)
    }

    try {
      const data = (await response.json()) as T
      signal.throwIfAborted()
      return { data, response }
    } catch {
      throw new GitHubActivityPollError('GitHub returned incomplete Star monitoring data.')
    }
  }

  async function accountId(token: string, signal: AbortSignal) {
    const result = await readJSON<{ id?: number }>(`${githubOrigin}/user`, token, signal)
    const id = result?.data?.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      throw new GitHubActivityPollError('GitHub did not identify the Star monitoring account.')
    }
    return id
  }

  async function verifiedSecondary(signal: AbortSignal) {
    if (!secondary) return
    if (!secondaryVerified) {
      const [primaryId, secondaryId] = await Promise.all([
        accountId(primary, signal),
        accountId(secondary, signal),
      ])
      if (primaryId !== secondaryId) {
        throw new GitHubActivityPollError(
          'GitHub Star monitoring tokens must belong to the same account.',
        )
      }
      secondaryVerified = true
    }
    return secondary
  }

  async function listFromToken(source: StarRepositorySource, token: string, signal: AbortSignal) {
    const path = source === 'watched' ? '/user/subscriptions' : '/user/repos'
    const first = new URL(path, githubOrigin)
    first.searchParams.set('per_page', String(pageSize))
    if (source === 'accessible') {
      first.searchParams.set('affiliation', 'owner,collaborator,organization_member')
    }

    const repositories: StarRepository[] = []
    const visited = new Set<string>()
    let url: string | undefined = first.href
    while (url) {
      if (visited.has(url) || visited.size >= maxPages) {
        throw new GitHubActivityPollError('GitHub Star repository pagination did not complete.')
      }
      visited.add(url)
      const optionalWatching = token === secondary && source === 'watched' && visited.size === 1
      const result = await readJSON<RepositoryMetadata[]>(
        url,
        token,
        signal,
        optionalWatching ? [403] : [],
      )
      if (!result) return []
      if (!Array.isArray(result.data) || result.data.length > pageSize) {
        throw new GitHubActivityPollError('GitHub returned an invalid Star repository list.')
      }
      for (const row of result.data) {
        if (typeof row?.full_name !== 'string' || !isRepositoryName(row.full_name)) {
          throw new GitHubActivityPollError('GitHub returned an invalid Star repository name.')
        }
        const starCount = row.stargazers_count
        repositories.push(
          validStarCount(starCount)
            ? { repository: row.full_name, starCount }
            : { repository: row.full_name },
        )
      }
      url = nextRepositoryPage(result.response, path)
    }
    return repositories
  }

  async function readCount(repository: string, token: string, signal: AbortSignal) {
    const result = await readJSON<RepositoryMetadata>(
      `${githubOrigin}/repos/${repository}`,
      token,
      signal,
      [401, 403, 404],
    )
    if (!result) return
    const metadata = result.data
    if (
      typeof metadata?.full_name !== 'string' ||
      metadata.full_name.toLowerCase() !== repository.toLowerCase() ||
      !validStarCount(metadata.stargazers_count)
    ) {
      throw new GitHubActivityPollError('GitHub returned invalid repository Star count metadata.')
    }
    return metadata.stargazers_count
  }

  return {
    async listRepositories(callerSignal) {
      const repositories = new Map<string, StarRepository>(
        explicit.map((repository) => [repository.toLowerCase(), { repository }]),
      )
      if (source) {
        const signal = pollSignal(callerSignal)
        const orgToken = await verifiedSecondary(signal)
        const lists = await Promise.all(
          (orgToken ? [primary, orgToken] : [primary]).map((token) =>
            listFromToken(source, token, signal),
          ),
        )
        for (const entry of lists.flat()) {
          const key = entry.repository.toLowerCase()
          const existing = repositories.get(key)
          if (!existing || (existing.starCount === undefined && entry.starCount !== undefined)) {
            repositories.set(key, entry)
          }
        }
      }
      return [...repositories.values()]
    },
    async readStarCount(repository, callerSignal) {
      if (!isRepositoryName(repository)) {
        throw new GitHubActivityPollError('Invalid repository for Star monitoring.')
      }
      const signal = pollSignal(callerSignal)
      const count = await readCount(repository, primary, signal)
      if (count !== undefined) return count
      const orgToken = await verifiedSecondary(signal)
      const fallback = orgToken ? await readCount(repository, orgToken, signal) : undefined
      if (fallback !== undefined) return fallback
      throw new GitHubActivityPollError('GitHub did not grant access to the repository Star count.')
    },
  }
}
