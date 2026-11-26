import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPullRequestDetailQuery,
  createPullRequestQuery,
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
