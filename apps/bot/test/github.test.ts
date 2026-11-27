import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPublicRepositoryQuery,
  createPullRequestChecksQuery,
  createPullRequestDetailQuery,
  createPullRequestQuery,
  createPullRequestReviewsQuery,
  listOpenPullRequests,
} from '../src/github.ts'

await test('collects both pages and keeps unavailable check data distinct from failure', async () => {
  const cursors: unknown[] = []
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://api.github.com/graphql')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token')

    const body = init?.body
    assert(typeof body === 'string')
    const { variables } = JSON.parse(body) as { variables: { after: string | null } }
    cursors.push(variables.after)
    const firstPage = variables.after === null
    const number = firstPage ? 12 : 5

    return Response.json({
      data: {
        viewer: {
          login: 'demo',
          pullRequests: {
            pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? 'cursor-1' : 'cursor-2' },
            nodes: [
              {
                number,
                title: 'Update the bot',
                url: `https://github.com/example/bot/pull/${number}`,
                isDraft: !firstPage,
                repository: { nameWithOwner: 'example/bot' },
                statusCheckRollup: firstPage ? { state: 'FAILURE' } : null,
              },
            ],
          },
        },
      },
    })
  }

  const result = await listOpenPullRequests('test-token', request)
  assert.deepEqual(cursors, [null, 'cursor-1'])
  assert.equal(result.login, 'demo')
  assert.deepEqual(
    result.pullRequests.map((pr) => [pr.number, pr.draft, pr.checks]),
    [
      [12, false, 'FAILURE'],
      [5, true, null],
    ],
  )
})

await test('does not treat an authorization error in an HTTP 200 response as an empty PR list', async () => {
  const request: typeof fetch = async () =>
    Response.json({
      data: null,
      errors: [{ message: 'Resource not accessible by personal access token' }],
    })

  await assert.rejects(listOpenPullRequests('test-token', request), /Resource not accessible/)
})

await test('reports org PRs as unavailable until an authorized token can read them', async () => {
  const repo = 'example/private-repo'
  const pr = {
    number: 65,
    title: 'Add preferences',
    url: 'https://github.com/example/private-repo/pull/65',
    isDraft: false,
    repository: { nameWithOwner: repo },
    statusCheckRollup: { state: 'FAILURE' },
  }
  const request: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get('authorization')
    if (input === 'https://api.github.com/graphql') {
      return Response.json({
        data: {
          viewer: {
            login: 'demo',
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: authorization === 'Bearer org-token' ? [pr] : [],
            },
          },
        },
      })
    }
    assert.equal(
      input,
      'https://api.github.com/repos/example/private-repo/pulls?state=open&per_page=1',
    )
    return new Response(null, { status: 404 })
  }

  const env = { GH_TOKEN: 'personal-token', GH_EXPECTED_REPOS: repo }
  const personal = createPullRequestQuery(env, request)
  assert.ok(personal)
  assert.deepEqual(await personal(), {
    login: 'demo',
    pullRequests: [],
    unavailableRepositories: [repo],
  })

  const withOrg = createPullRequestQuery({ ...env, GH_ORG_TOKEN: 'org-token' }, request)
  assert.ok(withOrg)
  const result = await withOrg()
  assert.deepEqual(
    result.pullRequests.map((row) => [row.number, row.checks]),
    [[65, 'FAILURE']],
  )
  assert.deepEqual(result.unavailableRepositories, [])
})

const detailNode = {
  number: 65,
  title: 'Add preferences',
  body: 'Add the preference controls.',
  url: 'https://github.com/example/private-repo/pull/65',
  state: 'MERGED',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'preferences',
  headRefOid: '123abc',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: null,
  changedFiles: 17,
  additions: 125,
  deletions: 36,
} as const

await test('reads a merged PR with org credentials and skips file requests for metadata', async () => {
  const tokens: (string | null)[] = []
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, 'https://api.github.com/graphql')
    assert.equal(init?.method, 'POST')
    assert.equal(typeof init.body, 'string')
    const { query, variables } = JSON.parse(init.body as string) as {
      query: string
      variables: unknown
    }
    assert.match(query, /query PullRequestDetail/)
    assert.deepEqual(variables, { owner: 'example', repo: 'private-repo', number: 65 })
    const token = new Headers(init.headers).get('authorization')
    tokens.push(token)
    if (token === 'Bearer personal-token') {
      return Response.json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] })
    }
    return Response.json({
      data: {
        repository: { nameWithOwner: 'example/private-repo', pullRequest: detailNode },
      },
    })
  }

  const detail = createPullRequestDetailQuery(
    { GH_TOKEN: 'personal-token', GH_ORG_TOKEN: 'org-token' },
    request,
  )
  assert.ok(detail)
  const pullRequest = await detail('example/private-repo', 65)
  assert.ok(pullRequest)
  assert.deepEqual(tokens, ['Bearer personal-token', 'Bearer org-token'])
  assert.equal(pullRequest.state, 'MERGED')
  assert.equal(pullRequest.checks, null)
  assert.equal(pullRequest.reviewDecision, 'APPROVED')
  assert.equal(pullRequest.changedFiles, 17)
  assert.equal(pullRequest.body, detailNode.body)
  assert.equal(pullRequest.files, undefined)
})

await test('bounds file patch excerpts and preserves unavailable patches and the next page', async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer org-token')
    if (input === 'https://api.github.com/graphql') {
      return Response.json({
        data: {
          repository: {
            nameWithOwner: 'example/private-repo',
            pullRequest: {
              ...detailNode,
              body: 'a'.repeat(7_000),
              isDraft: true,
              statusCheckRollup: { state: 'FAILURE' },
              changedFiles: 3_500,
            },
          },
        },
      })
    }
    assert.equal(
      input,
      'https://api.github.com/repos/example/private-repo/pulls/65/files?per_page=10&page=1',
    )
    return Response.json(
      [
        {
          filename: 'new.ts',
          previous_filename: 'old.ts',
          status: 'renamed',
          additions: 125,
          deletions: 36,
          patch: 'a'.repeat(2_500),
        },
        { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
      ],
      { headers: { link: '<https://api.github.com/page/2>; rel="next"' } },
    )
  }

  const detail = createPullRequestDetailQuery({ GH_ORG_TOKEN: 'org-token' }, request)
  assert.ok(detail)
  const pullRequest = await detail('example/private-repo', 65, 1)
  assert.ok(pullRequest?.files)
  assert.equal(pullRequest.body.length, 6_000)
  assert.equal(pullRequest.bodyTruncated, true)
  assert.equal(pullRequest.checks, 'FAILURE')
  assert.equal(pullRequest.draft, true)
  assert.equal(pullRequest.files.nextPage, 2)
  assert.equal(pullRequest.files.limitedByGitHub, true)
  assert.equal(pullRequest.files.entries[0].previousPath, 'old.ts')
  assert.equal(pullRequest.files.entries[0].patchExcerpt?.length, 2_000)
  assert.equal(pullRequest.files.entries[0].patchTruncated, true)
  assert.equal(pullRequest.files.entries[1].patchExcerpt, null)
})

await test('validates PR references before fetching and distinguishes rate limits from missing PRs', async () => {
  let calls = 0
  const request: typeof fetch = async () => {
    calls += 1
    if (calls === 1) return new Response(null, { status: 404 })
    return new Response('API rate limit exceeded', { status: 403 })
  }
  const detail = createPullRequestDetailQuery({ GH_TOKEN: 'test-token' }, request)
  assert.ok(detail)
  await assert.rejects(detail('example/..', 65), /owner\/repo/)
  await assert.rejects(detail('example/private-repo', 2_147_483_648), /positive PR number/)
  await assert.rejects(detail('example/private-repo', 65, 301), /between 1 and 300/)
  assert.equal(calls, 0)
  assert.equal(await detail('example/private-repo', 65), null)
  await assert.rejects(detail('example/private-repo', 65), /HTTP 403/)
})

await test('reads paginated check runs and commit statuses for the current PR head only', async () => {
  const firstHead = 'a'.repeat(40)
  const nextHead = 'b'.repeat(40)
  const checkedPaths: string[] = []
  let head = firstHead
  const request: typeof fetch = async (input) => {
    assert(typeof input === 'string')
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.github.com')
    if (url.pathname === '/repos/example/private-repo/pulls/65') {
      return Response.json({
        number: 65,
        html_url: detailNode.url,
        base: { repo: { full_name: 'example/private-repo' } },
        head: { sha: head },
      })
    }

    checkedPaths.push(url.pathname)
    assert.ok(url.pathname.startsWith(`/repos/example/private-repo/commits/${head}/`))
    const firstPage = url.searchParams.get('page') === '1'
    if (url.pathname.endsWith('/check-runs')) {
      assert.equal(url.searchParams.get('filter'), 'latest')
      if (head === nextHead) return Response.json({ total_count: 0, check_runs: [] })
      const run = {
        name: firstPage ? 'CI / unit tests' : 'CI / format',
        status: 'completed',
        conclusion: firstPage ? 'failure' : 'success',
        details_url: 'https://github.com/example/private-repo/actions/runs/123',
        html_url: null,
        app: { name: 'GitHub Actions' },
        started_at: '2026-11-26T10:00:00Z',
        completed_at: '2026-11-26T10:02:00Z',
      }
      const headers = firstPage
        ? { link: '<https://api.github.com/page/2>; rel="next"' }
        : undefined
      return Response.json({ total_count: 2, check_runs: [run] }, { headers })
    }

    assert.ok(url.pathname.endsWith('/status'))
    if (head === nextHead) return Response.json({ total_count: 0, statuses: [] })
    return Response.json({
      total_count: 1,
      statuses: [
        {
          context: 'external-ci/build',
          state: 'error',
          target_url: 'https://example.com/build/65',
          updated_at: '2026-11-26T10:01:00Z',
        },
      ],
    })
  }

  const checks = createPullRequestChecksQuery({ GH_TOKEN: 'test-token' }, request)
  assert.ok(checks)
  const result = await checks('example/private-repo', 65)
  assert.ok(result)
  assert.equal(result.headRefOid, firstHead)
  assert.equal(result.coverage, 'complete')
  assert.deepEqual(result.entries, [
    {
      kind: 'check_run',
      name: 'CI / unit tests',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://github.com/example/private-repo/actions/runs/123',
      provider: 'GitHub Actions',
      startedAt: '2026-11-26T10:00:00Z',
      completedAt: '2026-11-26T10:02:00Z',
    },
    {
      kind: 'check_run',
      name: 'CI / format',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/example/private-repo/actions/runs/123',
      provider: 'GitHub Actions',
      startedAt: '2026-11-26T10:00:00Z',
      completedAt: '2026-11-26T10:02:00Z',
    },
    {
      kind: 'commit_status',
      name: 'external-ci/build',
      status: 'error',
      url: 'https://example.com/build/65',
      updatedAt: '2026-11-26T10:01:00Z',
    },
  ])

  head = nextHead
  const next = await checks('example/private-repo', 65)
  assert.equal(next?.headRefOid, nextHead)
  assert.equal(next?.coverage, 'complete')
  assert.deepEqual(next?.entries, [])
  assert.equal(checkedPaths.filter((path) => path.includes(firstHead)).length, 3)
  assert.equal(checkedPaths.filter((path) => path.includes(nextHead)).length, 2)
})

await test('reports unavailable check runs separately from an empty commit status list', async () => {
  const head = 'a'.repeat(40)
  const requests: string[] = []
  const request: typeof fetch = async (input, init) => {
    assert(typeof input === 'string')
    const { pathname } = new URL(input)
    const authorization = new Headers(init?.headers).get('authorization')
    requests.push(`${pathname} ${authorization}`)
    if (authorization === 'Bearer personal-token') return new Response(null, { status: 404 })
    assert.equal(authorization, 'Bearer org-token')
    if (pathname.endsWith('/pulls/65')) {
      return Response.json({
        number: 65,
        html_url: detailNode.url,
        base: { repo: { full_name: 'example/private-repo' } },
        head: { sha: head },
      })
    }
    if (pathname.endsWith('/check-runs')) {
      return Response.json(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      )
    }
    assert.ok(pathname.endsWith('/status'))
    return Response.json({ total_count: 0, statuses: [] })
  }

  const checks = createPullRequestChecksQuery(
    { GH_TOKEN: 'personal-token', GH_ORG_TOKEN: 'org-token' },
    request,
  )
  assert.ok(checks)
  const result = await checks('example/private-repo', 65)
  assert.equal(result?.coverage, 'partial')
  assert.deepEqual(result?.sources, { checkRuns: 'unavailable', commitStatuses: 'complete' })
  assert.deepEqual(result?.entries, [])
  for (const path of ['/pulls/65', `/commits/${head}/check-runs`, `/commits/${head}/status`]) {
    assert.deepEqual(
      requests.filter((request) => request.includes(path)),
      [
        `/repos/example/private-repo${path} Bearer personal-token`,
        `/repos/example/private-repo${path} Bearer org-token`,
      ],
    )
  }
})

await test('reads submitted reviews and bounded unresolved comments with the authorized token', async () => {
  const tokens: (string | null)[] = []
  const submittedAt = '2026-11-26T11:00:00Z'
  const publishedComment = {
    author: { login: 'reviewer' },
    bodyText: 'Please validate the empty input.',
    url: detailNode.url + '#discussion_r51',
    publishedAt: submittedAt,
    isMinimized: false,
  }
  const publishedReview = {
    ...publishedComment,
    bodyText: 'x'.repeat(601),
    url: detailNode.url + '#pullrequestreview-50',
    state: 'CHANGES_REQUESTED',
    submittedAt,
  }
  const unresolved = {
    path: 'src/handler.ts',
    line: 22,
    isResolved: false,
    isOutdated: true,
    comments: {
      pageInfo: { hasNextPage: true },
      nodes: [
        publishedComment,
        { ...publishedComment, bodyText: 'Unsubmitted draft', publishedAt: null },
        { ...publishedComment, bodyText: 'Minimized comment', isMinimized: true },
      ],
    },
  }
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/graphql')
    const token = new Headers(init?.headers).get('authorization')
    tokens.push(token)
    assert(typeof init?.body === 'string')
    const body = JSON.parse(init.body) as { query: string; variables: unknown }
    assert.match(body.query, /reviewThreads\(last: 24\)/)
    assert.deepEqual(body.variables, { owner: 'example', repo: 'private-repo', number: 65 })
    if (token === 'Bearer personal-token') {
      return Response.json({ errors: [{ type: 'NOT_FOUND' }] })
    }
    return Response.json({
      data: {
        repository: {
          nameWithOwner: 'example/private-repo',
          pullRequest: {
            number: 65,
            url: detailNode.url,
            reviewDecision: 'CHANGES_REQUESTED',
            latestReviews: {
              pageInfo: { hasPreviousPage: false },
              nodes: [
                publishedReview,
                { ...publishedReview, bodyText: 'Draft review', state: 'PENDING' },
              ],
            },
            reviewThreads: {
              pageInfo: { hasPreviousPage: true },
              nodes: [unresolved, { ...unresolved, path: 'src/resolved.ts', isResolved: true }],
            },
            comments: { pageInfo: { hasPreviousPage: false }, nodes: [publishedComment] },
          },
        },
      },
    })
  }

  const reviews = createPullRequestReviewsQuery(
    { GH_TOKEN: 'personal-token', GH_ORG_TOKEN: 'org-token' },
    request,
  )
  assert.ok(reviews)
  const result = await reviews('example/private-repo', 65)
  assert.deepEqual(tokens, ['Bearer personal-token', 'Bearer org-token'])
  assert.equal(result?.reviewDecision, 'CHANGES_REQUESTED')
  assert.deepEqual(result?.reviews, [
    {
      author: 'reviewer',
      state: 'CHANGES_REQUESTED',
      submittedAt,
      body: 'x'.repeat(600),
      bodyTruncated: true,
      url: publishedReview.url,
    },
  ])
  assert.deepEqual(result?.unresolvedThreads, [
    {
      path: 'src/handler.ts',
      line: 22,
      outdated: true,
      comments: [
        {
          author: 'reviewer',
          body: publishedComment.bodyText,
          bodyTruncated: false,
          url: publishedComment.url,
        },
      ],
      commentsTruncated: true,
    },
  ])
  assert.deepEqual(result?.discussionComments, result?.unresolvedThreads[0].comments)
  assert.equal(result?.threadsTruncated, true)
  assert.equal(result?.reviewsTruncated, false)
})

await test('only accepts exact public repository metadata from unauthenticated GitHub', async () => {
  const repos: string[] = []
  const request: typeof fetch = async (input, init) => {
    assert(typeof input === 'string')
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(new Headers(init?.headers).has('authorization'), false)
    assert.equal(init?.redirect, 'manual')
    repos.push(url.pathname)
    if (url.pathname.endsWith('renamed')) return new Response(null, { status: 301 })
    if (url.pathname.endsWith('missing')) return new Response(null, { status: 404 })
    const metadata = { full_name: 'Example/Bot', visibility: 'public', private: false }
    return Response.json(
      url.pathname.endsWith('private')
        ? { ...metadata, visibility: 'private', private: true }
        : metadata,
    )
  }
  const isPublic = createPublicRepositoryQuery(request)
  assert.equal(await isPublic('example/bot'), true)
  assert.equal(await isPublic('example/different'), false)
  assert.equal(await isPublic('example/private'), false)
  assert.equal(await isPublic('example/renamed'), false)
  assert.equal(await isPublic('example/missing'), false)
  assert.equal(await isPublic('example/..'), false)
  assert.equal(await isPublic('example/bot?token=x'), false)
  assert.equal(repos.length, 5)
})
