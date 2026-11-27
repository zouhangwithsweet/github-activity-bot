const openPullRequestsQuery = `
  query OpenPullRequests($after: String) {
    viewer {
      login
      pullRequests(first: 50, after: $after, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          isDraft
          headRefOid
          repository { nameWithOwner }
          statusCheckRollup { state }
        }
      }
    }
  }
`

const pullRequestDetailQuery = `
  query PullRequestDetail($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner
      visibility
      pullRequest(number: $number) {
        number
        title
        body
        url
        state
        isDraft
        baseRefName
        headRefName
        headRefOid
        mergeable
        mergeStateStatus
        reviewDecision
        statusCheckRollup { state }
        changedFiles
        additions
        deletions
      }
    }
  }
`

const pullRequestReviewsQuery = `
  query PullRequestReviews($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner
      visibility
      pullRequest(number: $number) {
        number
        url
        reviewDecision
        latestReviews(last: 12) {
          pageInfo { hasPreviousPage }
          nodes { author { login } state submittedAt url bodyText isMinimized }
        }
        reviewThreads(last: 24) {
          pageInfo { hasPreviousPage }
          nodes {
            path
            line
            isResolved
            isOutdated
            comments(first: 3) {
              pageInfo { hasNextPage }
              nodes { author { login } bodyText url publishedAt isMinimized }
            }
          }
        }
        comments(last: 8) {
          pageInfo { hasPreviousPage }
          nodes { author { login } bodyText url publishedAt isMinimized }
        }
      }
    }
  }
`

const repositoryName = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/
const filesPerPage = 10
const maxListedFiles = 3_000
const maxDescriptionLength = 6_000
const maxPatchLength = 2_000
const checksPerPage = 50
const maxCheckPages = 4

export type CheckState = 'ERROR' | 'EXPECTED' | 'FAILURE' | 'PENDING' | 'SUCCESS'

export interface PullRequest {
  number: number
  title: string
  url: string
  draft: boolean
  repository: string
  checks: CheckState | null
}

export function hasFailingChecks(pr: PullRequest) {
  return pr.checks === 'FAILURE' || pr.checks === 'ERROR'
}

type PullRequestNode = Pick<PullRequest, 'number' | 'title' | 'url'> & {
  isDraft: boolean
  headRefOid: string
  repository: { nameWithOwner: string }
  statusCheckRollup: { state: CheckState } | null
}

interface GraphQLResponse {
  data?: {
    viewer: {
      login: string
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: (PullRequestNode | null)[]
      }
    }
  }
  errors?: { message: string }[]
}

interface PullRequestHead extends PullRequest {
  headSha: string | null
}

async function readOpenPullRequests(token: string, request: typeof fetch) {
  const pullRequests: PullRequestHead[] = []
  let after: string | null = null

  while (true) {
    const response = await request('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'github-activity-bot',
      },
      body: JSON.stringify({ query: openPullRequestsQuery, variables: { after } }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!response.ok) {
      throw new Error(
        `GitHub API returned HTTP ${response.status}. Check authentication and repository access.`,
      )
    }

    const result = (await response.json()) as GraphQLResponse
    if (result.errors?.length) {
      throw new Error(`GitHub GraphQL: ${result.errors.map((error) => error.message).join('; ')}`)
    }

    const viewer = result.data?.viewer
    if (!viewer) throw new Error('GitHub GraphQL returned no viewer.')

    const { nodes, pageInfo } = viewer.pullRequests
    for (const node of nodes) {
      if (!node) continue
      pullRequests.push({
        number: node.number,
        title: node.title,
        url: node.url,
        draft: node.isDraft,
        repository: node.repository.nameWithOwner,
        checks: node.statusCheckRollup?.state ?? null,
        headSha: /^[a-f0-9]{40}$/i.test(node.headRefOid) ? node.headRefOid : null,
      })
    }

    if (!pageInfo.hasNextPage) return { login: viewer.login, pullRequests }

    if (!pageInfo.endCursor || pageInfo.endCursor === after) {
      throw new Error('GitHub GraphQL did not advance the pull request cursor.')
    }
    after = pageInfo.endCursor
  }
}

export async function listOpenPullRequests(token: string, request: typeof fetch = fetch) {
  const { login, pullRequests } = await readOpenPullRequests(token, request)
  return { login, pullRequests: pullRequests.map(({ headSha: _headSha, ...pr }) => pr) }
}

interface PullRequestSnapshot {
  login: string
  pullRequests: PullRequest[]
  unavailableRepositories: string[]
}

export type PullRequestQuery = () => Promise<PullRequestSnapshot>

interface PullRequestDetailNode {
  number: number
  title: string
  body: string
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  baseRefName: string
  headRefName: string
  headRefOid: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  statusCheckRollup: { state: CheckState } | null
  changedFiles: number
  additions: number
  deletions: number
}

interface GitHubChangedFile {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string | null
}

export interface PullRequestDetail extends Omit<
  PullRequestDetailNode,
  'isDraft' | 'statusCheckRollup'
> {
  repository: string
  restrictedRepository?: true
  draft: boolean
  checks: CheckState | null
  bodyTruncated: boolean
  files?: {
    page: number
    nextPage: number | null
    limitedByGitHub: boolean
    entries: {
      path: string
      previousPath: string | null
      status: string
      additions: number
      deletions: number
      patchExcerpt: string | null
      patchTruncated: boolean
    }[]
  }
}

export type PullRequestDetailQuery = (
  repository: string,
  number: number,
  filesPage?: number,
) => Promise<PullRequestDetail | null>

export function githubTokens(env: NodeJS.ProcessEnv) {
  const personalToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
  return [
    ...new Set(
      [personalToken, env.GH_ORG_TOKEN?.trim()].filter((token): token is string => Boolean(token)),
    ),
  ]
}

export function isRepositoryName(value: string) {
  const name = value.split('/')[1]
  return repositoryName.test(value) && value === value.trim() && name !== '.' && name !== '..'
}

function validatePullRequestReference(repository: string, number: number) {
  if (!isRepositoryName(repository)) throw new Error('Expected a GitHub repository as owner/repo.')
  // GraphQL Int is a signed 32-bit integer.
  if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new Error('Expected a valid positive PR number.')
  }
}

export function hasNextPage(response: Response) {
  return /;\s*rel="next"/i.test(response.headers.get('link') ?? '')
}

async function canReadRepositoryPullRequests(
  repository: string,
  tokens: string[],
  request: typeof fetch,
) {
  for (const token of tokens) {
    const response = await request(
      `https://api.github.com/repos/${repository}/pulls?state=open&per_page=1`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'github-activity-bot',
        },
        signal: AbortSignal.timeout(10_000),
      },
    )
    await response.body?.cancel()
    if (response.ok) return true
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Could not check PR access for ${repository}: HTTP ${response.status}.`)
    }
  }
  return false
}

export function createPullRequestHeadQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const tokens = githubTokens(env)
  if (!tokens.length) return

  const expected = [
    ...new Set(
      (env.GH_EXPECTED_REPOS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  if (expected.some((repository) => !isRepositoryName(repository))) {
    throw new Error('GH_EXPECTED_REPOS must contain comma-separated owner/repo names.')
  }

  return async () => {
    const [primary, ...additional] = await Promise.all(
      tokens.map((token) => readOpenPullRequests(token, request)),
    )
    const merged = new Map<string, PullRequestHead>()
    const ambiguousHeads = new Set<string>()
    for (const result of [primary, ...additional]) {
      if (result.login.toLowerCase() !== primary.login.toLowerCase()) {
        throw new Error('GitHub personal and organization tokens must belong to the same account.')
      }
      for (const pr of result.pullRequests) {
        const key = `${pr.repository.toLowerCase()}#${pr.number}`
        const existing = merged.get(key)
        if (existing?.headSha && pr.headSha && existing.headSha !== pr.headSha) {
          ambiguousHeads.add(key)
        }
        if (
          !existing ||
          (existing.headSha === null && pr.headSha !== null) ||
          (existing.checks === null &&
            pr.checks !== null &&
            (existing.headSha === null || pr.headSha !== null))
        ) {
          merged.set(key, pr)
        }
      }
    }

    const pullRequests = [...merged.values()]
    const visible = new Set(pullRequests.map((pr) => pr.repository.toLowerCase()))
    const coverage = await Promise.all(
      expected.map(async (repository) => {
        const readable =
          visible.has(repository.toLowerCase()) ||
          (await canReadRepositoryPullRequests(repository, tokens, request))
        return { repository, readable }
      }),
    )
    const unavailableRepositories = coverage
      .filter((row) => !row.readable)
      .map((row) => row.repository)
    return { login: primary.login, pullRequests, unavailableRepositories, ambiguousHeads }
  }
}

export function createPullRequestQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestQuery | undefined {
  const query = createPullRequestHeadQuery(env, request)
  if (!query) return
  return async () => {
    const { pullRequests, ambiguousHeads: _ambiguousHeads, ...snapshot } = await query()
    return { ...snapshot, pullRequests: pullRequests.map(({ headSha: _headSha, ...pr }) => pr) }
  }
}

interface PullRequestGraphQLResponse<Node> {
  data?: {
    repository: { nameWithOwner: string; visibility?: string; pullRequest: Node | null } | null
  } | null
  errors?: { type?: string }[]
}

async function checkDetailResponse(response: Response) {
  if (response.ok) return true
  if (response.status === 404) return false
  if (response.status === 403) {
    const message = await response.text()
    if (
      response.headers.get('x-ratelimit-remaining') !== '0' &&
      !response.headers.has('retry-after') &&
      !/rate limit/i.test(message)
    ) {
      return false
    }
  }
  throw new Error(`GitHub PR query returned HTTP ${response.status}.`)
}

async function getPullRequestNode<Node>(
  query: string,
  token: string,
  owner: string,
  repo: string,
  number: number,
  request: typeof fetch,
) {
  const response = await request('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'github-activity-bot',
    },
    body: JSON.stringify({ query, variables: { owner, repo, number } }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!(await checkDetailResponse(response))) return null

  const result = (await response.json()) as PullRequestGraphQLResponse<Node>
  if (result.errors?.length) {
    if (result.errors.every((error) => error.type === 'NOT_FOUND' || error.type === 'FORBIDDEN')) {
      return null
    }
    throw new Error('GitHub could not complete the PR detail query.')
  }
  if (!result.data) throw new Error('GitHub returned no PR detail data.')
  const repository = result.data.repository
  if (!repository?.pullRequest) return null

  return {
    repository: repository.nameWithOwner,
    node: repository.pullRequest,
    ...(repository.visibility === 'PRIVATE' || repository.visibility === 'INTERNAL'
      ? { restrictedRepository: true as const }
      : {}),
  }
}

async function getPullRequestDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
  request: typeof fetch,
) {
  const result = await getPullRequestNode<PullRequestDetailNode>(
    pullRequestDetailQuery,
    token,
    owner,
    repo,
    number,
    request,
  )
  if (!result) return null
  const { node, ...repository } = result
  const { isDraft, statusCheckRollup, body, ...fields } = node
  return {
    ...fields,
    ...repository,
    draft: isDraft,
    checks: statusCheckRollup?.state ?? null,
    body: body.slice(0, maxDescriptionLength),
    bodyTruncated: body.length > maxDescriptionLength,
  }
}

async function getPullRequestFiles(
  token: string,
  pr: PullRequestDetail,
  page: number,
  request: typeof fetch,
): Promise<NonNullable<PullRequestDetail['files']> | null> {
  const response = await request(
    `https://api.github.com/repos/${pr.repository}/pulls/${pr.number}/files?per_page=${filesPerPage}&page=${page}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'github-activity-bot',
      },
      signal: AbortSignal.timeout(20_000),
    },
  )
  if (!(await checkDetailResponse(response))) return null
  const files = (await response.json()) as GitHubChangedFile[]
  return {
    page,
    nextPage: page * filesPerPage < maxListedFiles && hasNextPage(response) ? page + 1 : null,
    limitedByGitHub: pr.changedFiles > maxListedFiles,
    entries: files.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchExcerpt: file.patch?.slice(0, maxPatchLength) ?? null,
      patchTruncated: (file.patch?.length ?? 0) > maxPatchLength,
    })),
  }
}

export function createPullRequestDetailQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestDetailQuery | undefined {
  const tokens = githubTokens(env)
  if (!tokens.length) return

  return async (repository, number, filesPage) => {
    validatePullRequestReference(repository, number)
    if (
      filesPage !== undefined &&
      (!Number.isInteger(filesPage) || filesPage < 1 || filesPage > maxListedFiles / filesPerPage)
    ) {
      throw new Error('Expected a file page between 1 and 300.')
    }

    const [owner, repo] = repository.split('/')
    let filesUnavailable = false
    for (const token of tokens) {
      const detail = await getPullRequestDetail(token, owner, repo, number, request)
      if (!detail) continue
      if (filesPage === undefined) return detail

      const files = await getPullRequestFiles(token, detail, filesPage, request)
      if (files) return { ...detail, files }
      filesUnavailable = true
    }
    if (filesUnavailable) throw new Error('GitHub credentials could not read the changed files.')
    return null
  }
}

type CheckCoverage = 'complete' | 'partial' | 'unavailable'

interface CheckRun {
  kind: 'check_run'
  name: string
  status: string
  conclusion: string | null
  url: string | null
  provider: string | null
  startedAt: string | null
  completedAt: string | null
}

interface CommitStatus {
  kind: 'commit_status'
  name: string
  status: string
  url: string | null
  updatedAt: string
}

interface PullRequestChecks {
  repository: string
  restrictedRepository?: true
  number: number
  url: string
  headRefOid: string
  coverage: CheckCoverage
  sources: { checkRuns: CheckCoverage; commitStatuses: CheckCoverage }
  entries: (CheckRun | CommitStatus)[]
}

export type PullRequestChecksQuery = (
  repository: string,
  number: number,
) => Promise<PullRequestChecks | null>

interface GitHubPullRequestHead {
  number: number
  html_url: string
  base: { repo: { full_name: string; private?: boolean; visibility?: string } }
  head: { sha: string }
}

interface GitHubCheckRun {
  name: string
  status: string
  conclusion: string | null
  details_url: string | null
  html_url: string | null
  app: { name: string } | null
  started_at: string | null
  completed_at: string | null
}

interface GitHubCommitStatus {
  context: string
  state: string
  target_url: string | null
  updated_at: string
}

export async function readGitHubRest(path: string, tokens: string[], request: typeof fetch) {
  let failure: unknown
  for (const token of tokens) {
    try {
      const response = await request(`https://api.github.com${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'github-activity-bot',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (await checkDetailResponse(response)) return response
      if (!response.bodyUsed) await response.body?.cancel()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
  return null
}

function checkLink(...links: (string | null)[]) {
  return links.find((link) => link && /^https?:\/\//i.test(link)) ?? null
}

async function readCheckPages<Row, Entry>(
  path: string,
  collection: 'check_runs' | 'statuses',
  toEntry: (row: Row) => Entry,
  tokens: string[],
  request: typeof fetch,
): Promise<{ coverage: CheckCoverage; entries: Entry[] }> {
  const entries: Entry[] = []
  const filter = collection === 'check_runs' ? '&filter=latest' : ''
  try {
    for (let page = 1; page <= maxCheckPages; page += 1) {
      const response = await readGitHubRest(
        `${path}?per_page=${checksPerPage}&page=${page}${filter}`,
        tokens,
        request,
      )
      if (!response) break

      const result = (await response.json()) as Record<typeof collection, Row[]> & {
        total_count: number
      }
      const rows = result[collection]
      if (!Array.isArray(rows) || !Number.isSafeInteger(result.total_count)) break
      entries.push(...rows.map(toEntry))
      if (!hasNextPage(response) && entries.length >= result.total_count) {
        return { coverage: 'complete', entries }
      }
    }
  } catch {
    // A failed page must not make an incomplete result appear to have no checks.
  }
  return { coverage: entries.length ? 'partial' : 'unavailable', entries }
}

export function createPullRequestChecksQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestChecksQuery | undefined {
  const tokens = githubTokens(env)
  if (!tokens.length) return

  return async (repository, number) => {
    validatePullRequestReference(repository, number)
    const response = await readGitHubRest(`/repos/${repository}/pulls/${number}`, tokens, request)
    if (!response) return null

    const pullRequest = (await response.json()) as GitHubPullRequestHead
    const headRefOid = pullRequest.head.sha
    const base = pullRequest.base.repo
    const canonicalRepository = base.full_name
    if (!/^[a-f0-9]{40}$/i.test(headRefOid) || !isRepositoryName(canonicalRepository)) {
      throw new Error('GitHub did not return a valid pull request head commit.')
    }

    const commit = `/repos/${canonicalRepository}/commits/${headRefOid}`
    const [checkRuns, commitStatuses] = await Promise.all([
      readCheckPages<GitHubCheckRun, CheckRun>(
        `${commit}/check-runs`,
        'check_runs',
        (run) => ({
          kind: 'check_run',
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          url: checkLink(run.details_url, run.html_url),
          provider: run.app?.name ?? null,
          startedAt: run.started_at,
          completedAt: run.completed_at,
        }),
        tokens,
        request,
      ),
      readCheckPages<GitHubCommitStatus, CommitStatus>(
        `${commit}/status`,
        'statuses',
        (status) => ({
          kind: 'commit_status',
          name: status.context,
          status: status.state,
          url: checkLink(status.target_url),
          updatedAt: status.updated_at,
        }),
        tokens,
        request,
      ),
    ])

    const sources = { checkRuns: checkRuns.coverage, commitStatuses: commitStatuses.coverage }
    let coverage: CheckCoverage = 'partial'
    if (sources.checkRuns === sources.commitStatuses) coverage = sources.checkRuns

    return {
      repository: canonicalRepository,
      ...(base.private === true || base.visibility === 'private' || base.visibility === 'internal'
        ? { restrictedRepository: true as const }
        : {}),
      number: pullRequest.number,
      url: pullRequest.html_url,
      headRefOid,
      coverage,
      sources,
      entries: [...checkRuns.entries, ...commitStatuses.entries],
    }
  }
}

interface ReviewCommentNode {
  author: { login: string } | null
  bodyText: string
  url: string
  publishedAt: string | null
  isMinimized: boolean
}

interface ReviewNode extends Omit<ReviewCommentNode, 'publishedAt'> {
  state: string
  submittedAt: string | null
}

interface ReviewConnection<Node> {
  pageInfo: { hasPreviousPage: boolean }
  nodes: (Node | null)[]
}

interface ReviewThreadNode {
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: {
    pageInfo: { hasNextPage: boolean }
    nodes: (ReviewCommentNode | null)[]
  }
}

interface PullRequestReviewsNode extends Pick<
  PullRequestDetailNode,
  'number' | 'url' | 'reviewDecision'
> {
  latestReviews: ReviewConnection<ReviewNode> | null
  reviewThreads: ReviewConnection<ReviewThreadNode>
  comments: ReviewConnection<ReviewCommentNode>
}

interface ReviewComment {
  author: string | null
  body: string
  bodyTruncated: boolean
  url: string
}

export interface PullRequestReviews extends Pick<
  PullRequestReviewsNode,
  'number' | 'url' | 'reviewDecision'
> {
  repository: string
  restrictedRepository?: true
  reviews: (ReviewComment & { state: string; submittedAt: string })[]
  unresolvedThreads: {
    path: string
    line: number | null
    outdated: boolean
    comments: ReviewComment[]
    commentsTruncated: boolean
  }[]
  discussionComments: ReviewComment[]
  reviewsTruncated: boolean
  threadsTruncated: boolean
  discussionCommentsTruncated: boolean
}

export type PullRequestReviewsQuery = (
  repository: string,
  number: number,
) => Promise<PullRequestReviews | null>

function reviewComment(node: Omit<ReviewCommentNode, 'publishedAt'>): ReviewComment {
  const maxLength = 600
  return {
    author: node.author?.login ?? null,
    body: node.bodyText.slice(0, maxLength),
    bodyTruncated: node.bodyText.length > maxLength,
    url: node.url,
  }
}

function publishedComments(nodes: (ReviewCommentNode | null)[]) {
  return nodes.flatMap((node) =>
    node?.publishedAt && !node.isMinimized ? [reviewComment(node)] : [],
  )
}

export function createPullRequestReviewsQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestReviewsQuery | undefined {
  const tokens = githubTokens(env)
  if (!tokens.length) return

  return async (repository, number) => {
    validatePullRequestReference(repository, number)
    const [owner, repo] = repository.split('/')
    let failure: unknown
    for (const token of tokens) {
      try {
        const result = await getPullRequestNode<PullRequestReviewsNode>(
          pullRequestReviewsQuery,
          token,
          owner,
          repo,
          number,
          request,
        )
        if (!result) continue
        const { node, ...repositoryInfo } = result
        const { latestReviews, reviewThreads, comments, ...fields } = node
        const reviews = (latestReviews?.nodes ?? []).flatMap((review) =>
          review?.submittedAt && !review.isMinimized && review.state !== 'PENDING'
            ? [{ ...reviewComment(review), state: review.state, submittedAt: review.submittedAt }]
            : [],
        )
        const unresolvedThreads = reviewThreads.nodes.flatMap((thread) => {
          if (!thread || thread.isResolved) return []
          const entries = publishedComments(thread.comments.nodes)
          if (!entries.length) return []
          return [
            {
              path: thread.path,
              line: thread.line,
              outdated: thread.isOutdated,
              comments: entries,
              commentsTruncated: thread.comments.pageInfo.hasNextPage,
            },
          ]
        })

        return {
          ...fields,
          ...repositoryInfo,
          reviews,
          unresolvedThreads,
          discussionComments: publishedComments(comments.nodes),
          reviewsTruncated: latestReviews?.pageInfo.hasPreviousPage ?? true,
          threadsTruncated: reviewThreads.pageInfo.hasPreviousPage,
          discussionCommentsTruncated: comments.pageInfo.hasPreviousPage,
        }
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
    return null
  }
}

// Indeterminate results block this reply but do not permanently mark the conversation private.
export type PublicRepositoryQuery = (repository: string) => Promise<boolean | undefined>

export function createPublicRepositoryQuery(request: typeof fetch = fetch): PublicRepositoryQuery {
  return async (repository) => {
    if (!isRepositoryName(repository)) return
    try {
      const response = await request(`https://api.github.com/repos/${repository}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'github-activity-bot',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        return
      }
      const data = (await response.json()) as {
        full_name?: unknown
        visibility?: unknown
        private?: unknown
      }
      if (
        typeof data.full_name !== 'string' ||
        data.full_name.toLowerCase() !== repository.toLowerCase()
      )
        return
      if (data.visibility === 'private' || data.visibility === 'internal' || data.private === true)
        return false
      if (data.visibility === 'public' && data.private === false) return true
    } catch {
      return undefined
    }
  }
}
