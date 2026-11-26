import assert from 'node:assert/strict'
import test from 'node:test'
import { listOpenPullRequests } from '../src/github.ts'

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
