import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createGitHubNotificationsQuery,
  createPullRequestActivityQuery,
  GitHubActivityPollError,
} from '../src/github-activity.ts'

const head = 'a'.repeat(40)
const own = {
  number: 12,
  title: 'Current user’s PR',
  url: 'https://github.com/example/bot/pull/12',
  headRefOid: head,
  isDraft: false,
  statusCheckRollup: { state: 'SUCCESS' },
  repository: { nameWithOwner: 'example/bot' },
}

await test('uses own open PR heads in one list query and checks explicit additions only once', async () => {
  const queried: unknown[] = []
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.github.com/graphql')
    assert(typeof init?.body === 'string')
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: unknown }
    queried.push(variables)
    if (query.includes('OpenPullRequests')) {
      assert.match(query, /headRefOid/)
      return Response.json({
        data: {
          viewer: {
            login: 'owner',
            pullRequests: { nodes: [own], pageInfo: { hasNextPage: false } },
          },
        },
      })
    }
    if (queried.length === 2) {
      return Response.json({
        data: {
          repository: {
            nameWithOwner: 'example/extra',
            pullRequest: {
              ...own,
              number: 10,
              title: 'Tracked PR',
              url: 'https://github.com/example/extra/pull/10',
              body: '',
              statusCheckRollup: { state: 'FAILURE' },
            },
          },
        },
      })
    }
    return Response.json({ errors: [{ type: 'NOT_FOUND' }] })
  }
  const poll = createPullRequestActivityQuery(
    { GH_TOKEN: 'configured-token', GH_TRACKED_PRS: 'EXAMPLE/bot#12,example/extra#10' },
    request,
  )
  assert.ok(poll)
  const snapshot = await poll([
    { repository: 'EXAMPLE/EXTRA', number: 10 },
    { repository: 'example/missing', number: 22 },
  ])
  assert.deepEqual(queried, [
    { after: null },
    { owner: 'EXAMPLE', repo: 'EXTRA', number: 10 },
    { owner: 'example', repo: 'missing', number: 22 },
  ])
  assert.deepEqual(snapshot, {
    login: 'owner',
    pullRequests: [
      {
        repository: 'example/bot',
        number: 12,
        title: own.title,
        url: own.url,
        headSha: head,
        state: 'SUCCESS',
      },
      {
        repository: 'example/extra',
        number: 10,
        title: 'Tracked PR',
        url: 'https://github.com/example/extra/pull/10',
        headSha: head,
        state: 'FAILURE',
      },
    ],
    unavailableRepositories: [],
    unavailablePullRequests: [{ repository: 'example/missing', number: 22 }],
  })
})

await test('reports a safe numeric GitHub poll delay on rate limits', async () => {
  const poll = createPullRequestActivityQuery(
    { GH_TOKEN: 'configured-token' },
    async () => new Response(null, { status: 429, headers: { 'retry-after': '12' } }),
  )
  assert.ok(poll)
  await assert.rejects(
    poll(),
    (error) => error instanceof GitHubActivityPollError && error.retryAfterMs === 12_000,
  )
})

const updated = '2026-11-26T22:00:00Z'
const thread = {
  id: 'notification-1',
  updated_at: updated,
  reason: 'review_requested',
  repository: { full_name: 'example/bot' },
  subject: {
    title: 'Review needed',
    type: 'PullRequest',
    url: 'https://api.github.com/repos/example/bot/pulls/17',
  },
}
const lastModified = 'Thu, 26 Nov 2026 22:00:00 GMT'
const previousModified = 'Thu, 26 Nov 2026 21:00:00 GMT'
const validNext =
  '<https://api.github.com/notifications?all=true&is_done=false&per_page=50&page=2>; rel="next"'

await test('checks notification identity, follows trusted pages, and retains cursor on 304', async () => {
  let polls = 0
  const request: typeof fetch = async (input, init) => {
    assert(typeof input === 'string')
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init?.redirect, 'error')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer notification-token')
    if (url.pathname === '/user') {
      return Response.json({ login: 'Owner' })
    }
    assert.equal(url.pathname, '/notifications')
    assert.equal(url.searchParams.get('all'), 'true')
    if (url.searchParams.get('page') === '2') {
      assert.equal(headers.get('if-modified-since'), null)
      return Response.json([
        { ...thread, updated_at: '2026-11-26T21:00:00Z' },
        {
          ...thread,
          id: 'external',
          subject: { ...thread.subject, url: 'https://outside.invalid/' },
        },
      ])
    }
    polls += 1
    if (polls === 1) {
      assert.equal(headers.get('if-none-match'), '"old"')
      assert.equal(headers.get('if-modified-since'), previousModified)
      return Response.json([thread, { ...thread, id: 'irrelevant', reason: 'subscribed' }], {
        headers: {
          link: validNext,
          etag: '"new"',
          'last-modified': lastModified,
          'x-poll-interval': '60',
        },
      })
    }
    assert.equal(headers.get('if-none-match'), '"new"')
    assert.equal(headers.get('if-modified-since'), lastModified)
    return new Response(null, { status: 304, headers: { 'x-poll-interval': '120' } })
  }
  const poll = createGitHubNotificationsQuery(
    { GH_NOTIFICATIONS_TOKEN: 'notification-token' },
    request,
  )
  assert.ok(poll)
  const first = await poll('owner', { etag: '"old"', lastModified: previousModified })
  assert.deepEqual(first, {
    items: [
      {
        id: thread.id,
        updatedAt: updated,
        reason: thread.reason,
        title: thread.subject.title,
        url: 'https://github.com/example/bot/pull/17',
        repository: 'example/bot',
      },
    ],
    cursor: { etag: '"new"', lastModified, pollIntervalMs: 60_000 },
    trackedPullRequests: [{ repository: 'example/bot', number: 17 }],
  })
  assert.deepEqual(await poll('OWNER', first.cursor), {
    items: [],
    trackedPullRequests: [],
    cursor: { ...first.cursor, pollIntervalMs: 120_000 },
  })
})

await test('rejects a notification credential from a different user before reading the inbox', async () => {
  const paths: string[] = []
  const poll = createGitHubNotificationsQuery(
    { GH_NOTIFICATIONS_TOKEN: 'notification-token' },
    async (url) => {
      assert(typeof url === 'string')
      paths.push(new URL(url).pathname)
      return Response.json({ login: 'someone-else' })
    },
  )
  assert.ok(poll)
  await assert.rejects(poll('owner'), /same GitHub account/)
  assert.deepEqual(paths, ['/user'])
})

await test('rejects off-origin notification pagination without returning a changed cursor', async () => {
  const paths: string[] = []
  const poll = createGitHubNotificationsQuery(
    { GH_NOTIFICATIONS_TOKEN: 'notification-token' },
    async (input, init) => {
      assert(typeof input === 'string')
      const url = new URL(input)
      paths.push(url.href)
      if (url.pathname === '/user') return Response.json({ login: 'owner' })
      assert.equal(new Headers(init?.headers).get('if-modified-since'), previousModified)
      return Response.json([thread], {
        headers: {
          link: '<https://outside.invalid/notifications?page=2>; rel="next"',
          'last-modified': lastModified,
        },
      })
    },
  )
  assert.ok(poll)
  const cursor = { lastModified: previousModified }
  await assert.rejects(poll('owner', cursor), /invalid notification pagination link/)
  await assert.rejects(poll('owner', cursor), /invalid notification pagination link/)
  assert(paths.every((path) => path.startsWith('https://api.github.com/')))
  assert.equal(paths.length, 3)
})
