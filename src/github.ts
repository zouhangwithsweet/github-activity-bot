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
  const personalToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
  const tokens = [
    ...new Set(
      [personalToken, env.GH_ORG_TOKEN?.trim()].filter((token): token is string => Boolean(token)),
    ),
  ]
  if (!tokens.length) return

  const expected = [
    ...new Set(
      (env.GH_EXPECTED_REPOS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  if (expected.some((repository) => !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository))) {
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
