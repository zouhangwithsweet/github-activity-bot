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
