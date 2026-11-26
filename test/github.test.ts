import assert from 'node:assert/strict'
import test from 'node:test'
import { createPullRequestQuery, listOpenPullRequests } from '../src/github.ts'

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
