import assert from 'node:assert/strict'
import test from 'node:test'
import { createPullRequestPreviewQuery } from '../src/github-preview.ts'

const repository = 'Example/Console'
const head = 'a'.repeat(40)
const otherHead = 'b'.repeat(40)
const preview = 'https://console-123abcdef-example-team.vercel.app'
const adminPreview = 'https://admin-123abcdef-example-team.vercel.app'
const path = `/repos/${repository}/deployments`
const env = { GH_TOKEN: 'personal-token', GH_ORG_TOKEN: 'org-token' }

function requestURL(input: Parameters<typeof fetch>[0]) {
  assert.ok(typeof input === 'string')
  return new URL(input)
}

function deployment(id: number, overrides: { [key: string]: unknown } = {}) {
  return { id, sha: head, production_environment: false, environment: 'Preview', ...overrides }
}

function status(id: number, overrides: { [key: string]: unknown } = {}) {
  return {
    id,
    created_at: '2026-11-27T14:25:19Z',
    state: 'success',
    environment_url: preview,
    ...overrides,
  }
}

await test('reads only exact-head preview deployment statuses with GitHub read credentials', async () => {
  const calls: string[] = []
  const query = createPullRequestPreviewQuery(env, async (input, init) => {
    const url = requestURL(input)
    const auth = new Headers(init?.headers).get('authorization')
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal instanceof AbortSignal)
    calls.push(`${url.pathname}:${auth}`)
    if (auth === 'Bearer personal-token') return new Response('', { status: 403 })
    if (url.pathname === path) {
      assert.equal(url.searchParams.get('sha'), head)
      return Response.json([
        deployment(1),
        deployment(2, { sha: otherHead }),
        deployment(3, { production_environment: true }),
        deployment(4, { environment: 'Production – console' }),
        deployment(5, { production_environment: null }),
      ])
    }
    assert.equal(url.pathname, `${path}/1/statuses`)
    return Response.json([status(1, { environment_url: `${preview}/` })])
  })

  assert.deepEqual(await query(repository, head.toUpperCase()), {
    kind: 'ready',
    origin: new URL(preview),
  })
  assert.deepEqual(calls, [
    `${path}:Bearer personal-token`,
    `${path}:Bearer org-token`,
    `${path}/1/statuses:Bearer personal-token`,
    `${path}/1/statuses:Bearer org-token`,
  ])
})

await test('uses a deployment’s current status when an older attempt succeeded', async () => {
  let current = status(2, { state: 'in_progress' })
  const query = createPullRequestPreviewQuery(env, async (input) => {
    const { pathname } = requestURL(input)
    if (pathname === path) return Response.json([deployment(1)])
    return Response.json([status(1), current])
  })

  assert.deepEqual(await query(repository, head), { kind: 'pending' })
  current = status(2, { state: 'inactive' })
  assert.deepEqual(await query(repository, head), { kind: 'missing' })
  current = status(2, { environment: 'production' })
  assert.deepEqual(await query(repository, head), { kind: 'missing' })
})

await test('rejects URLs outside generated Vercel origins and ignores check or log links', async () => {
  const rejected = [
    'https://vercel.com/teams/invite?commitId=123',
    'https://console-git-feature-123abcdef-example-team.vercel.app',
    'https://console.vercel.app',
    `${preview}.example.com`,
    `${preview}:443`,
    `${preview}/?x-vercel-protection-bypass=fixture`,
    `${preview}/#fragment`,
    `${preview}/login`,
    `${preview}\n`,
    preview.replace('https://', 'https://user@'),
    preview.replace('https://', 'http://'),
    undefined,
  ]
  const query = createPullRequestPreviewQuery(env, async (input) => {
    const { pathname } = requestURL(input)
    if (pathname === path) return Response.json(rejected.map((_, index) => deployment(index + 1)))
    const id = Number(pathname.split('/').at(-2))
    return Response.json([
      status(1, { environment_url: rejected[id - 1], log_url: preview, target_url: preview }),
    ])
  })

  assert.deepEqual(await query(repository, head), { kind: 'missing' })
})

await test('distinguishes ambiguity, missing deployments, and unavailable GitHub data', async () => {
  let deployments = Response.json([deployment(1), deployment(2)])
  let secondURL = adminPreview
  const query = createPullRequestPreviewQuery(env, async (input) => {
    const { pathname } = requestURL(input)
    if (pathname === path) return deployments.clone()
    return Response.json([
      status(1, { environment_url: pathname.includes('/2/') ? secondURL : preview }),
    ])
  })

  assert.deepEqual(await query(repository, head), { kind: 'ambiguous' })
  secondURL = preview
  assert.deepEqual(await query(repository, head), { kind: 'ready', origin: new URL(preview) })
  deployments = Response.json([])
  assert.deepEqual(await query(repository, head), { kind: 'missing' })
  deployments = new Response('', { status: 403 })
  assert.deepEqual(await query(repository, head), { kind: 'unavailable' })
  deployments = Response.json([deployment(1)], {
    headers: { link: `<https://api.github.com${path}?page=2>; rel="next"` },
  })
  assert.deepEqual(await query(repository, head), { kind: 'unavailable' })
})

await test('honors cancellation and skips GitHub calls with invalid inputs or missing credentials', async () => {
  let calls = 0
  const request: typeof fetch = async (_input, init) => {
    calls += 1
    assert.ok(init?.signal)
    if (!init.signal.aborted) {
      await new Promise((resolve) =>
        init.signal!.addEventListener('abort', resolve, { once: true }),
      )
    }
    init.signal.throwIfAborted()
    return Response.json([])
  }
  const query = createPullRequestPreviewQuery(env, request)
  const controller = new AbortController()

  assert.deepEqual(await query(repository, 'main'), { kind: 'unavailable' })
  assert.deepEqual(await query('../console', head), { kind: 'unavailable' })
  assert.deepEqual(await createPullRequestPreviewQuery({}, request)(repository, head), {
    kind: 'unavailable',
  })
  assert.equal(calls, 0)

  const work = query(repository, head, controller.signal)
  controller.abort()
  assert.deepEqual(await work, { kind: 'unavailable' })
  assert.equal(calls, 1)
})
