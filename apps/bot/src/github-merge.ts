import { isRepositoryName } from './github.ts'

export type MergeMethod = 'merge' | 'squash' | 'rebase'

type BlockedReason =
  | 'invalid_reference'
  | 'not_allowed'
  | 'permission_or_protection'
  | 'not_found_or_inaccessible'
  | 'cannot_merge'
  | 'invalid_request'
  | 'rate_limited'

type UnknownReason = 'request_failed' | 'unexpected_response' | 'github_unavailable'

export type MergeResult =
  | { status: 'merged'; sha: string }
  | { status: 'stale'; reason: 'head_changed' }
  | { status: 'blocked'; reason: BlockedReason }
  | { status: 'unknown'; reason: UnknownReason }

export type MergeFailureReason = Exclude<MergeResult, { status: 'merged' }>['reason']

interface MergeInput {
  repository: string
  number: number
  headSha: string
}

interface PullRequestMerger {
  method: MergeMethod
  canMerge(repository: string): boolean
  merge(input: MergeInput): Promise<MergeResult>
}

function shaIsValid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
}

function mergeMethod(env: NodeJS.ProcessEnv): MergeMethod {
  const method = env.GH_MERGE_METHOD?.trim().toLowerCase() || 'squash'
  if (method === 'merge' || method === 'squash' || method === 'rebase') return method
  throw new Error('GH_MERGE_METHOD must be merge, squash, or rebase.')
}

async function classifyMergeResponse(response: Response): Promise<MergeResult> {
  const { status } = response
  if (status === 200) {
    const body: unknown = await response.json().catch(() => undefined)
    if (body && typeof body === 'object' && 'merged' in body) {
      if (body.merged === false) return { status: 'blocked', reason: 'cannot_merge' }
      if (body.merged === true && 'sha' in body && shaIsValid(body.sha)) {
        return { status: 'merged', sha: body.sha.toLowerCase() }
      }
    }
    return { status: 'unknown', reason: 'unexpected_response' }
  }

  if (status === 403 || status === 422) {
    const text = await response.text().catch(() => '')
    if (
      response.headers.get('x-ratelimit-remaining') === '0' ||
      response.headers.has('retry-after') ||
      /rate limit|abuse detection|has been spammed/i.test(text)
    ) {
      return { status: 'blocked', reason: 'rate_limited' }
    }
  } else {
    await response.body?.cancel().catch(() => {})
  }

  switch (status) {
    case 400:
    case 422:
      return { status: 'blocked', reason: 'invalid_request' }
    case 401:
    case 403:
      return { status: 'blocked', reason: 'permission_or_protection' }
    case 404:
      return { status: 'blocked', reason: 'not_found_or_inaccessible' }
    case 405:
      return { status: 'blocked', reason: 'cannot_merge' }
    case 409:
      return { status: 'stale', reason: 'head_changed' }
    case 429:
      return { status: 'blocked', reason: 'rate_limited' }
    default:
      return {
        status: 'unknown',
        reason: status === 408 || status >= 500 ? 'github_unavailable' : 'unexpected_response',
      }
  }
}

export function createPullRequestMerger(
  env: NodeJS.ProcessEnv = process.env,
  requester: typeof fetch = fetch,
): PullRequestMerger {
  const token = env.GH_MERGE_TOKEN?.trim()
  const method = mergeMethod(env)
  const repositories = (env.GH_MERGE_REPOSITORIES ?? '')
    .split(',')
    .map((repository) => repository.trim())
    .filter(Boolean)
  if (repositories.some((repository) => !isRepositoryName(repository))) {
    throw new Error('GH_MERGE_REPOSITORIES must contain comma-separated owner/repo names.')
  }
  const allowed = new Set(repositories.map((repository) => repository.toLowerCase()))
  const canMerge = (repository: string) => Boolean(token && allowed.has(repository.toLowerCase()))

  return {
    method,
    canMerge,
    async merge({ repository, number, headSha }) {
      if (
        !isRepositoryName(repository) ||
        !Number.isInteger(number) ||
        number < 1 ||
        number > 2_147_483_647 ||
        !shaIsValid(headSha)
      ) {
        return { status: 'blocked', reason: 'invalid_reference' }
      }
      if (!canMerge(repository)) return { status: 'blocked', reason: 'not_allowed' }

      let response: Response
      try {
        response = await requester(
          `https://api.github.com/repos/${repository}/pulls/${number}/merge`,
          {
            method: 'PUT',
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'user-agent': 'github-activity-bot',
              'x-github-api-version': '2026-03-10',
            },
            body: JSON.stringify({ sha: headSha.toLowerCase(), merge_method: method }),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          },
        )
      } catch {
        // The server may have performed the write before the response was lost.
        return { status: 'unknown', reason: 'request_failed' }
      }
      return classifyMergeResponse(response)
    },
  }
}
