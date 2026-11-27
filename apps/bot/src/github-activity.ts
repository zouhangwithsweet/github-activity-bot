import {
  type CheckState,
  createPullRequestDetailQuery,
  createPullRequestHeadQuery,
  isRepositoryName,
} from './github.ts'

export interface TrackedPullRequest {
  repository: string
  number: number
}

export interface PullRequestObservation extends TrackedPullRequest {
  title: string
  url: string
  headSha: string
  state: CheckState | null
}

export interface PullRequestActivitySnapshot {
  login: string
  pullRequests: PullRequestObservation[]
  unavailableRepositories: string[]
  unavailablePullRequests: TrackedPullRequest[]
}

export type PullRequestActivityQuery = (
  tracked?: readonly TrackedPullRequest[],
) => Promise<PullRequestActivitySnapshot>

export class GitHubActivityPollError extends Error {
  readonly retryAfterMs: number | undefined

  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.retryAfterMs = retryAfterMs
  }
}

const gitHubOrigin = 'https://api.github.com'
const maxNotificationPages = 20
const watchedReasons = new Set(['assign', 'comment', 'mention', 'review_requested', 'team_mention'])

function pullRequestKey(pr: TrackedPullRequest) {
  return `${pr.repository.toLowerCase()}#${pr.number}`
}

function parsePullRequest(value: string): TrackedPullRequest | undefined {
  const match = /^([^#]+)#([1-9]\d*)$/.exec(value)
  if (!match || !isRepositoryName(match[1])) return
  const number = Number(match[2])
  if (!Number.isInteger(number) || number > 2_147_483_647) return
  return { repository: match[1], number }
}

function configuredPullRequests(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const pr = parsePullRequest(part)
      if (!pr)
        throw new Error('GH_TRACKED_PRS must contain comma-separated owner/repo#number references.')
      return pr
    })
}

function delayInMilliseconds(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return
  const milliseconds = Number(value) * 1_000
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) return milliseconds
}

export function retryDelay(headers: Headers) {
  const retryAfter = headers.get('retry-after')
  const seconds = delayInMilliseconds(retryAfter)
  const retryDate = retryAfter && /[A-Za-z]/.test(retryAfter) ? Date.parse(retryAfter) : NaN
  const reset =
    headers.get('x-ratelimit-remaining') === '0'
      ? delayInMilliseconds(headers.get('x-ratelimit-reset'))
      : undefined
  const delay = Math.max(seconds ?? 0, (reset ?? 0) - Date.now(), (retryDate || 0) - Date.now())
  return delay > 0 ? delay : undefined
}

export function createPullRequestActivityQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestActivityQuery | undefined {
  const configured = configuredPullRequests(env.GH_TRACKED_PRS)
  const credentials = {
    GH_TOKEN: env.GH_TOKEN,
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GH_ORG_TOKEN: env.GH_ORG_TOKEN,
    GH_EXPECTED_REPOS: env.GH_EXPECTED_REPOS,
  }
  if (!createPullRequestHeadQuery(credentials, request)) return

  return async (tracked = []) => {
    let retryAfterMs: number | undefined
    const observedRequest: typeof fetch = async (...args) => {
      const response = await request(...args)
      if (!response.ok || response.headers.get('x-ratelimit-remaining') === '0') {
        const delay = retryDelay(response.headers)
        if (delay !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, delay)
      }
      return response
    }
    const list = createPullRequestHeadQuery(credentials, observedRequest)!
    const detail = createPullRequestDetailQuery(credentials, observedRequest)!
    try {
      const source = await list()
      const observed = new Map<string, PullRequestObservation>()
      const unavailable = new Map<string, TrackedPullRequest>()
      for (const { repository, number, headSha, checks, title, url } of source.pullRequests) {
        const key = pullRequestKey({ repository, number })
        if (headSha && !source.ambiguousHeads.has(key)) {
          observed.set(key, { repository, number, title, url, headSha, state: checks })
        } else {
          unavailable.set(key, { repository, number })
        }
      }

      const extra = new Map(
        [...configured, ...tracked, ...unavailable.values()].map((pr) => [pullRequestKey(pr), pr]),
      )
      for (const key of observed.keys()) extra.delete(key)
      const pending = [...extra.values()]
      for (let offset = 0; offset < pending.length; offset += 5) {
        const batch = pending.slice(offset, offset + 5)
        const details = await Promise.all(
          batch.map(({ repository, number }) => detail(repository, number)),
        )
        for (const [index, ref] of batch.entries()) {
          const key = pullRequestKey(ref)
          const pr = details[index]
          if (!pr || !/^[a-f0-9]{40}$/i.test(pr.headRefOid)) {
            unavailable.set(key, ref)
            continue
          }
          observed.set(key, {
            repository: pr.repository,
            number: pr.number,
            title: pr.title,
            url: pr.url,
            headSha: pr.headRefOid,
            state: pr.checks,
          })
          unavailable.delete(key)
        }
      }

      return {
        login: source.login,
        pullRequests: [...observed.values()],
        unavailableRepositories: source.unavailableRepositories,
        unavailablePullRequests: [...unavailable.values()],
      }
    } catch (error) {
      if (retryAfterMs !== undefined) {
        throw new GitHubActivityPollError(
          'GitHub pull request polling was rate-limited.',
          retryAfterMs,
        )
      }
      throw error
    }
  }
}

export interface GitHubNotificationCursor {
  etag?: string
  lastModified?: string
  pollIntervalMs?: number
}

export interface GitHubNotification {
  id: string
  updatedAt: string
  reason: string
  title: string
  url: string
  repository: string
}

interface NotificationSnapshot {
  items: GitHubNotification[]
  cursor: GitHubNotificationCursor
  trackedPullRequests: TrackedPullRequest[]
}

export type GitHubNotificationsQuery = (
  login: string,
  cursor?: GitHubNotificationCursor,
) => Promise<NotificationSnapshot>

interface NotificationNode {
  id: string
  updated_at: string
  reason: string
  repository: { full_name: string }
  subject: {
    title: string
    type: string
    url: string | null
  }
}

function notificationSubject(node: NotificationNode) {
  if (!node || !watchedReasons.has(node.reason)) return
  const { type, url, title } = node.subject
  const repository = node.repository.full_name
  if (type !== 'PullRequest' && type !== 'Issue') return
  if (url === null) return
  if (!isRepositoryName(repository)) return
  const apiUrl = URL.parse(url)
  if (
    apiUrl?.origin !== gitHubOrigin ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  )
    return
  const kind = type === 'PullRequest' ? 'pulls' : 'issues'
  const [, prefix, owner, repo, segment, number, extra] = apiUrl.pathname.split('/')
  if (
    prefix !== 'repos' ||
    `${owner}/${repo}`.toLowerCase() !== repository.toLowerCase() ||
    segment !== kind ||
    extra !== undefined
  ) {
    return
  }
  const ref = parsePullRequest(`${repository}#${number}`)
  if (
    !ref ||
    typeof node.id !== 'string' ||
    !node.id ||
    !Number.isFinite(Date.parse(node.updated_at)) ||
    typeof title !== 'string'
  )
    return
  return {
    item: {
      id: node.id,
      updatedAt: node.updated_at,
      reason: node.reason,
      title,
      url: `https://github.com/${repository}/${type === 'PullRequest' ? 'pull' : 'issues'}/${ref.number}`,
      repository,
    },
    pullRequest: type === 'PullRequest' ? ref : undefined,
  }
}

function nextNotificationsPage(response: Response, pollIntervalMs?: number) {
  const link = /<([^>]+)>\s*;\s*rel="next"/i.exec(response.headers.get('link') ?? '')
  if (!link) return
  const url = URL.parse(link[1], gitHubOrigin)
  if (
    url?.origin !== gitHubOrigin ||
    url.pathname !== '/notifications' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new GitHubActivityPollError(
      'GitHub returned an invalid notification pagination link.',
      pollIntervalMs,
    )
  }
  return url.href
}

export function createGitHubNotificationsQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): GitHubNotificationsQuery | undefined {
  const token = env.GH_NOTIFICATIONS_TOKEN?.trim()
  if (!token) return
  let verifiedLogin: string | undefined

  const get = (url: string, conditional?: Headers) => {
    const headers = new Headers(conditional)
    headers.set('authorization', `Bearer ${token}`)
    headers.set('accept', 'application/vnd.github+json')
    headers.set('user-agent', 'github-activity-bot')
    return request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  }

  return async (login, cursor = {}) => {
    const expectedLogin = login.trim().toLowerCase()
    if (!expectedLogin) throw new GitHubActivityPollError('GitHub notification account is unknown.')
    if (!verifiedLogin) {
      const response = await get(`${gitHubOrigin}/user`)
      if (!response.ok) {
        throw new GitHubActivityPollError(
          `GitHub could not verify the notification token account (HTTP ${response.status}).`,
          retryDelay(response.headers),
        )
      }
      const account = (await response.json()) as { login?: unknown }
      if (typeof account.login !== 'string' || !account.login) {
        throw new GitHubActivityPollError('GitHub did not identify the notification token account.')
      }
      verifiedLogin = account.login.toLowerCase()
    }
    if (verifiedLogin !== expectedLogin) {
      throw new GitHubActivityPollError(
        'GH_NOTIFICATIONS_TOKEN must belong to the same GitHub account.',
      )
    }

    const firstPage = `${gitHubOrigin}/notifications?all=true&is_done=false&per_page=50`
    const conditional = new Headers()
    if (cursor.etag) conditional.set('if-none-match', cursor.etag)
    if (cursor.lastModified) conditional.set('if-modified-since', cursor.lastModified)

    const items = new Map<string, GitHubNotification>()
    const tracked = new Map<string, TrackedPullRequest>()
    const visited = new Set<string>()
    let nextCursor: GitHubNotificationCursor = {}
    let url: string | undefined = firstPage
    while (url) {
      if (visited.has(url) || visited.size >= maxNotificationPages) {
        throw new GitHubActivityPollError(
          'GitHub notification pagination did not complete.',
          nextCursor.pollIntervalMs,
        )
      }
      visited.add(url)
      const response = await get(url, url === firstPage ? conditional : undefined)
      const interval = delayInMilliseconds(response.headers.get('x-poll-interval'))
      if (url === firstPage && response.status === 304) {
        return {
          items: [],
          cursor: {
            etag: cursor.etag,
            lastModified: cursor.lastModified,
            pollIntervalMs: interval ?? cursor.pollIntervalMs,
          },
          trackedPullRequests: [],
        }
      }
      if (!response.ok) {
        throw new GitHubActivityPollError(
          `GitHub notifications returned HTTP ${response.status}.`,
          Math.max(
            retryDelay(response.headers) ?? 0,
            interval ?? 0,
            nextCursor.pollIntervalMs ?? 0,
          ) || undefined,
        )
      }
      if (url === firstPage) {
        nextCursor = {
          etag: response.headers.get('etag') ?? undefined,
          lastModified: response.headers.get('last-modified') ?? undefined,
          pollIntervalMs: interval ?? cursor.pollIntervalMs,
        }
      }
      const nodes: unknown = await response.json()
      if (!Array.isArray(nodes)) {
        throw new GitHubActivityPollError(
          'GitHub returned an invalid notification list.',
          nextCursor.pollIntervalMs,
        )
      }
      for (const node of nodes as NotificationNode[]) {
        const subject = notificationSubject(node)
        if (!subject) continue
        const { item, pullRequest } = subject
        const previous = items.get(item.id)
        if (!previous || Date.parse(item.updatedAt) > Date.parse(previous.updatedAt))
          items.set(item.id, item)
        if (pullRequest) tracked.set(pullRequestKey(pullRequest), pullRequest)
      }
      url = nextNotificationsPage(response, nextCursor.pollIntervalMs)
    }
    return {
      items: [...items.values()],
      cursor: nextCursor,
      trackedPullRequests: [...tracked.values()],
    }
  }
}
