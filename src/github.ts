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

const repositoryName = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/
const filesPerPage = 10
const maxListedFiles = 3_000
const maxDescriptionLength = 6_000
const maxPatchLength = 2_000

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

export async function listOpenPullRequests(token: string, request: typeof fetch = fetch) {
  const pullRequests: PullRequest[] = []
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
      })
    }

    if (!pageInfo.hasNextPage) return { login: viewer.login, pullRequests }

    if (!pageInfo.endCursor || pageInfo.endCursor === after) {
      throw new Error('GitHub GraphQL did not advance the pull request cursor.')
    }
    after = pageInfo.endCursor
  }
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

function githubTokens(env: NodeJS.ProcessEnv) {
  const personalToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
  return [
    ...new Set(
      [personalToken, env.GH_ORG_TOKEN?.trim()].filter((token): token is string => Boolean(token)),
    ),
  ]
}

function isRepositoryName(value: string) {
  const name = value.split('/')[1]
  return repositoryName.test(value) && value === value.trim() && name !== '.' && name !== '..'
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

export function createPullRequestQuery(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): PullRequestQuery | undefined {
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
      tokens.map((token) => listOpenPullRequests(token, request)),
    )
    const merged = new Map<string, PullRequest>()
    for (const result of [primary, ...additional]) {
      if (result.login.toLowerCase() !== primary.login.toLowerCase()) {
        throw new Error('GitHub personal and organization tokens must belong to the same account.')
      }
      for (const pr of result.pullRequests) {
        const key = `${pr.repository.toLowerCase()}#${pr.number}`
        const existing = merged.get(key)
        if (!existing || (existing.checks === null && pr.checks !== null)) merged.set(key, pr)
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
    return { login: primary.login, pullRequests, unavailableRepositories }
  }
}

interface PullRequestDetailResponse {
  data?: {
    repository: { nameWithOwner: string; pullRequest: PullRequestDetailNode | null } | null
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

async function getPullRequestDetail(
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
    body: JSON.stringify({ query: pullRequestDetailQuery, variables: { owner, repo, number } }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!(await checkDetailResponse(response))) return null

  const result = (await response.json()) as PullRequestDetailResponse
  if (result.errors?.length) {
    if (result.errors.every((error) => error.type === 'NOT_FOUND' || error.type === 'FORBIDDEN')) {
      return null
    }
    throw new Error('GitHub could not complete the PR detail query.')
  }
  if (!result.data) throw new Error('GitHub returned no PR detail data.')
  const repository = result.data.repository
  if (!repository?.pullRequest) return null

  const { isDraft, statusCheckRollup, body, ...fields } = repository.pullRequest
  return {
    ...fields,
    repository: repository.nameWithOwner,
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
    nextPage:
      page * filesPerPage < maxListedFiles &&
      /;\s*rel="next"/i.test(response.headers.get('link') ?? '')
        ? page + 1
        : null,
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
    if (!isRepositoryName(repository))
      throw new Error('Expected a GitHub repository as owner/repo.')
    // GraphQL Int is a signed 32-bit integer.
    if (!Number.isInteger(number) || number < 1 || number > 2_147_483_647) {
      throw new Error('Expected a valid positive PR number.')
    }
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
