import assert from 'node:assert/strict'
import test from 'node:test'
import { createPullRequestMerger, type MergeResult } from '../src/github-merge.ts'

const repository = 'Example/Bot'
const headSha = 'a'.repeat(40)
const mergedSha = 'b'.repeat(40)
const input = { repository, number: 73, headSha }
const token = 'write-token-fixture'
const env = { GH_MERGE_TOKEN: token, GH_MERGE_REPOSITORIES: 'example/bot, example/other' }

await test('sends exactly one head-pinned GitHub PUT with the dedicated merge credential', async () => {
  let calls = 0
  const merger = createPullRequestMerger({ ...env, GH_TOKEN: 'read-token' }, async (url, init) => {
    calls += 1
    assert.equal(url, 'https://api.github.com/repos/Example/Bot/pulls/73/merge')
    assert.equal(init?.method, 'PUT')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), `Bearer ${token}`)
    assert.equal(headers.get('content-type'), 'application/json')
    assert(typeof init.body === 'string')
    assert.deepEqual(JSON.parse(init.body), { sha: headSha, merge_method: 'squash' })
    return Response.json({ merged: true, sha: mergedSha, message: 'not surfaced' })
  })
  assert.equal(merger.method, 'squash')
  assert.equal(merger.canMerge(repository), true)
  assert.equal(merger.canMerge('examPLE/OTHER'), true)
  assert.equal(merger.canMerge('example/unlisted'), false)
  assert.deepEqual(await merger.merge(input), { status: 'merged', sha: mergedSha })
  assert.equal(calls, 1)
})

await test('rejects unlisted targets, invalid immutable references, and absent write configuration locally', async () => {
  const noRequest: typeof fetch = async () => assert.fail('Unexpected GitHub merge request')
  const disabled = createPullRequestMerger(
    { ...env, GH_MERGE_TOKEN: '', GH_TOKEN: 'read-token' },
    noRequest,
  )
  const missingAllowlist = createPullRequestMerger({ GH_MERGE_TOKEN: token }, noRequest)
  const enabled = createPullRequestMerger(env, noRequest)
  for (const merger of [disabled, missingAllowlist]) {
    assert.equal(merger.canMerge(repository), false)
    assert.deepEqual(await merger.merge(input), { status: 'blocked', reason: 'not_allowed' })
  }
  assert.deepEqual(await enabled.merge({ ...input, repository: 'example/unlisted' }), {
    status: 'blocked',
    reason: 'not_allowed',
  })
  for (const invalid of [
    { ...input, repository: 'example/..' },
    { ...input, number: 0 },
    { ...input, number: 1.2 },
    { ...input, headSha: 'deadbeef' },
    { ...input, headSha: 'z'.repeat(40) },
  ]) {
    assert.deepEqual(await enabled.merge(invalid), {
      status: 'blocked',
      reason: 'invalid_reference',
    })
  }
  assert.throws(
    () => createPullRequestMerger({ ...env, GH_MERGE_REPOSITORIES: 'example/bot, *' }, noRequest),
    /GH_MERGE_REPOSITORIES/,
  )
  assert.throws(
    () => createPullRequestMerger({ ...env, GH_MERGE_METHOD: 'automatic' }, noRequest),
    /GH_MERGE_METHOD/,
  )
})

await test('classifies GitHub responses and an ambiguous transport failure without retries or raw data', async () => {
  const details = 'server detail to withhold'
  const cases: [Response | undefined, MergeResult][] = [
    [new Response(details, { status: 409 }), { status: 'stale', reason: 'head_changed' }],
    [new Response(details, { status: 405 }), { status: 'blocked', reason: 'cannot_merge' }],
    [
      new Response(details, { status: 403 }),
      { status: 'blocked', reason: 'permission_or_protection' },
    ],
    [
      new Response(details, { status: 403, headers: { 'Retry-After': '60' } }),
      { status: 'blocked', reason: 'rate_limited' },
    ],
    [
      new Response('You have exceeded a secondary rate limit.', { status: 422 }),
      { status: 'blocked', reason: 'rate_limited' },
    ],
    [
      new Response(details, { status: 404 }),
      { status: 'blocked', reason: 'not_found_or_inaccessible' },
    ],
    [new Response(details, { status: 503 }), { status: 'unknown', reason: 'github_unavailable' }],
    [
      Response.json({ merged: false, message: details }),
      { status: 'blocked', reason: 'cannot_merge' },
    ],
    [
      Response.json({ merged: true, sha: details }),
      { status: 'unknown', reason: 'unexpected_response' },
    ],
    [undefined, { status: 'unknown', reason: 'request_failed' }],
  ]
  let calls = 0
  const merger = createPullRequestMerger(
    { ...env, GH_MERGE_METHOD: ' Rebase ' },
    async (_url, init) => {
      assert(typeof init?.body === 'string')
      assert.deepEqual(JSON.parse(init.body), { sha: headSha, merge_method: 'rebase' })
      const [response] = cases[calls++]
      if (!response) throw new Error(details)
      return response
    },
  )
  assert.equal(merger.method, 'rebase')
  for (const [, expected] of cases) assert.deepEqual(await merger.merge(input), expected)
  assert.equal(calls, cases.length)
})
