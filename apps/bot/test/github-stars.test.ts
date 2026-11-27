import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHubActivityPollError } from '../src/github-activity.ts'
import { createGitHubStarQueries } from '../src/github-stars.ts'

const repository = 'Example/Console'
const origin = 'https://api.github.com'
const env = { GH_TOKEN: 'personal-token', GH_ORG_TOKEN: 'org-token' }

function requestURL(input: Parameters<typeof fetch>[0]) {
  assert.ok(typeof input === 'string')
  const url = new URL(input)
  assert.equal(url.origin, origin)
  return url
}

await test('combines explicit and paginated watched repositories for the same GitHub user', async () => {
  const calls: string[] = []
  const query = createGitHubStarQueries(
    { source: 'watched', repositories: [repository] },
    env,
    async (input, init) => {
      const url = requestURL(input)
      const token = new Headers(init?.headers).get('authorization')
      assert.equal(init?.method, 'GET')
      assert.equal(init?.redirect, 'error')
      calls.push(`${url.pathname}:${token}`)
      if (url.pathname === '/user') return Response.json({ id: 42 })
      assert.equal(url.pathname, '/user/subscriptions')
      assert.equal(url.searchParams.get('per_page'), '100')
      if (token === 'Bearer org-token') return Response.json([{ full_name: 'Org/Private' }])
      if (url.searchParams.get('page') === '2')
        return Response.json([{ full_name: 'example/Backend' }])
      return Response.json(
        [{ full_name: 'example/console', stargazers_count: 9 }, { full_name: 'Public/Project' }],
        { headers: { link: `<${origin}/user/subscriptions?per_page=100&page=2>; rel="next"` } },
      )
    },
  )!

  assert.deepEqual(await query.listRepositories(), [
    { repository: 'example/console', starCount: 9 },
    { repository: 'Public/Project' },
    { repository: 'example/Backend' },
    { repository: 'Org/Private' },
  ])
  assert.deepEqual(calls.slice(0, 2).sort(), [
    '/user:Bearer org-token',
    '/user:Bearer personal-token',
  ])
  assert.equal(
    calls.filter((call) => call === '/user/subscriptions:Bearer personal-token').length,
    2,
  )
})

await test('lists accessible repositories and rejects a foreign pagination link', async () => {
  let invalidLink = false
  const query = createGitHubStarQueries(
    { source: 'accessible', repositories: [] },
    { GH_TOKEN: 'token' },
    async (input) => {
      const url = requestURL(input)
      assert.equal(url.pathname, '/user/repos')
      assert.equal(url.searchParams.get('affiliation'), 'owner,collaborator,organization_member')
      return Response.json(
        [{ full_name: repository, stargazers_count: 0 }],
        invalidLink
          ? {
              headers: { link: '<https://outside.example/user/repos?page=2>; rel="next"' },
            }
          : {},
      )
    },
  )!

  assert.deepEqual(await query.listRepositories(), [{ repository, starCount: 0 }])
  invalidLink = true
  await assert.rejects(query.listRepositories(), /invalid Star repository pagination link/)
})

await test('keeps primary watched and explicit repositories when the org token lacks Watching access', async () => {
  let rateLimited = false
  const query = createGitHubStarQueries(
    { source: 'watched', repositories: [repository] },
    env,
    async (input, init) => {
      const { pathname } = requestURL(input)
      const org = new Headers(init?.headers).get('authorization') === 'Bearer org-token'
      if (pathname === '/user') return Response.json({ id: 42 })
      assert.equal(pathname, '/user/subscriptions')
      if (org) {
        return new Response(null, {
          status: 403,
          headers: rateLimited ? { 'retry-after': '7' } : {},
        })
      }
      return Response.json([{ full_name: 'Example/Watched', stargazers_count: 9 }])
    },
  )!

  assert.deepEqual(await query.listRepositories(), [
    { repository },
    { repository: 'Example/Watched', starCount: 9 },
  ])
  rateLimited = true
  await assert.rejects(
    query.listRepositories(),
    (error) => error instanceof GitHubActivityPollError && error.retryAfterMs === 7_000,
  )
})

await test('keeps explicit scope local and reads a numeric Star count using only repository metadata', async () => {
  let calls = 0
  const query = createGitHubStarQueries(
    { repositories: [repository] },
    { GH_ORG_TOKEN: 'org-token' },
    async (input, init) => {
      calls += 1
      assert.equal(requestURL(input).pathname, '/repos/Example/Console')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer org-token')
      assert.equal(init?.method, 'GET')
      assert.equal(init?.redirect, 'error')
      return Response.json({ full_name: repository.toLowerCase(), stargazers_count: 0 })
    },
  )!

  assert.deepEqual(await query.listRepositories(), [{ repository }])
  assert.equal(calls, 0)
  assert.equal(await query.readStarCount(repository), 0)
  assert.equal(calls, 1)
})

await test('only falls back to a secondary credential owned by the same user', async () => {
  let mismatched = true
  let orgMetadataReads = 0
  const query = createGitHubStarQueries(
    { repositories: [repository] },
    env,
    async (input, init) => {
      const { pathname } = requestURL(input)
      const org = new Headers(init?.headers).get('authorization') === 'Bearer org-token'
      if (pathname === '/user') return Response.json({ id: org && mismatched ? 24 : 42 })
      assert.equal(pathname, '/repos/Example/Console')
      if (!org) return new Response(null, { status: 404 })
      orgMetadataReads += 1
      return Response.json({ full_name: repository, stargazers_count: 12_345 })
    },
  )!

  await assert.rejects(query.readStarCount(repository), /must belong to the same account/)
  assert.equal(orgMetadataReads, 0)
  mismatched = false
  assert.equal(await query.readStarCount(repository), 12_345)
  assert.equal(orgMetadataReads, 1)
})

await test('rejects invalid inputs and unrelated or invalid repository count metadata', async () => {
  let calls = 0
  let body: unknown
  const query = createGitHubStarQueries({ repositories: [] }, { GH_TOKEN: 'token' }, async () => {
    calls += 1
    return Response.json(body)
  })!

  await assert.rejects(query.readStarCount('../Console'), /Invalid repository for Star monitoring/)
  assert.equal(calls, 0)
  for (const metadata of [
    { full_name: 'Example/Other', stargazers_count: 5 },
    { full_name: repository, stargazers_count: -1 },
    { full_name: repository, stargazers_count: 2.5 },
    { full_name: repository, stargazers_count: '125' },
    { full_name: repository },
  ]) {
    body = metadata
    await assert.rejects(query.readStarCount(repository), /invalid repository Star count metadata/)
  }
})

await test('propagates rate-limit backoff and prevents canceled requests', async () => {
  let calls = 0
  const query = createGitHubStarQueries({ repositories: [] }, env, async (input) => {
    calls += 1
    assert.equal(requestURL(input).pathname, '/repos/Example/Console')
    return new Response(null, { status: 403, headers: { 'retry-after': '7' } })
  })!

  await assert.rejects(
    query.readStarCount(repository),
    (error) => error instanceof GitHubActivityPollError && error.retryAfterMs === 7_000,
  )
  await assert.rejects(
    query.readStarCount(repository, AbortSignal.abort()),
    /failed or was canceled/,
  )
  assert.equal(calls, 1)
})
