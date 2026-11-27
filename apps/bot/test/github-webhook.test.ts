import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { createGitHubWebhookServer, type GitHubWebhookEvent } from '../src/github-webhook.ts'

const secret = 'test-signature-key'
const repository = { full_name: 'Example/Bot', id: 100, html_url: 'https://outside.invalid/' }
const sender = { login: 'octocat' }
const head = 'a'.repeat(40)
const time = 1_790_000_000_000

function delivery(name: string, payload: string, id = 'delivery-1') {
  return {
    method: 'POST' as const,
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': name,
      'x-github-delivery': id,
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex'),
    },
    payload,
  }
}

await test('verifies raw bytes before parsing and reports signed malformed input', async (t) => {
  const events: unknown[] = []
  const server = createGitHubWebhookServer({
    secret,
    repository: 'example/bot',
    receive(id, event) {
      events.push(id, event)
      return true
    },
  })
  t.after(() => server.close())
  const body = '{ "repository":{"full_name":"Example/Bot"}, "action":"created", "note":"测试" }\n'
  const signed = delivery('star', body)
  const tampered = await server.inject({ ...signed, payload: body.trim() })
  assert.equal(tampered.statusCode, 401)
  const invalid = delivery('star', '{')
  assert.equal(
    (
      await server.inject({
        ...invalid,
        headers: { ...invalid.headers, 'x-hub-signature-256': 'bad' },
      })
    ).statusCode,
    401,
  )
  assert.equal((await server.inject(invalid)).statusCode, 400)
  assert.equal((await server.inject(delivery('star', body, ''))).statusCode, 400)
  assert.deepEqual(events, [])
  assert.equal((await server.inject(signed)).statusCode, 202)
  assert.deepEqual(events, [
    'delivery-1',
    {
      kind: 'star',
      repository: 'Example/Bot',
      action: 'created',
      url: 'https://github.com/Example/Bot',
    },
  ])
})

await test('acknowledges durable acceptance and repeats without enqueuing another event', async (t) => {
  const inbox = new Map<string, { event: GitHubWebhookEvent; receivedAt: number }>()
  let finish: (() => void) | undefined
  let started: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const commit = new Promise<void>((resolve) => {
    finish = resolve
  })
  const server = createGitHubWebhookServer({
    secret,
    repository: 'example/bot',
    now: () => time,
    async receive(id, event, receivedAt) {
      started?.()
      await commit
      if (inbox.has(id)) return false
      inbox.set(id, { event, receivedAt })
      return true
    },
  })
  t.after(() => server.close())
  const request = delivery(
    'fork',
    JSON.stringify({ repository, sender, forkee: { full_name: 'octocat/fork' } }),
  )
  const pending = server.inject(request)
  await ready
  assert.equal(inbox.size, 0)
  finish?.()
  assert.equal((await pending).statusCode, 202)
  assert.equal((await server.inject(request)).statusCode, 200)
  assert.deepEqual(
    [...inbox],
    [
      [
        'delivery-1',
        {
          event: {
            kind: 'fork',
            repository: 'Example/Bot',
            action: 'forked',
            actor: 'octocat',
            url: 'https://github.com/octocat/fork',
          },
          receivedAt: time,
        },
      ],
    ],
  )
})

await test('supports signed ping and ignores unrelated repositories, actions and event names', async (t) => {
  const server = createGitHubWebhookServer({
    secret,
    repository: 'example/bot',
    receive: () => assert.fail('Unexpected event queued'),
  })
  t.after(() => server.close())
  assert.equal((await server.inject(delivery('ping', '{"zen":"hello"}'))).statusCode, 200)
  assert.equal(
    (await server.inject(delivery('push', JSON.stringify({ repository })))).statusCode,
    204,
  )
  assert.equal(
    (
      await server.inject(
        delivery(
          'star',
          JSON.stringify({
            repository: { full_name: 'example/another' },
            action: 'created',
          }),
        ),
      )
    ).statusCode,
    204,
  )
  assert.equal(
    (
      await server.inject(
        delivery(
          'check_run',
          JSON.stringify({
            repository,
            action: 'created',
            check_run: { head_sha: head },
          }),
        ),
      )
    ).statusCode,
    204,
  )
})

await test('normalizes pull requests and the completed check, workflow and commit status variants', async (t) => {
  const events: GitHubWebhookEvent[] = []
  const server = createGitHubWebhookServer({
    secret,
    repository: 'example/bot',
    receive(_id, event) {
      events.push(event)
      return true
    },
  })
  t.after(() => server.close())
  const check = {
    head_sha: head.toUpperCase(),
    id: 25,
    pull_requests: [
      { number: 9, base: { repo: { id: 100 } } },
      { number: 7, base: { repo: { id: 200 } } },
    ],
  }
  const requests = [
    [
      'pull_request',
      { action: 'synchronize', number: 9, pull_request: { number: 9, head: { sha: head } } },
    ],
    ['check_run', { action: 'completed', check_run: check }],
    ['check_suite', { action: 'completed', check_suite: check }],
    ['workflow_run', { action: 'completed', workflow_run: check }],
    ['status', { sha: head, state: 'failure', target_url: 'https://outside.invalid/' }],
  ] as const
  for (const [name, payload] of requests) {
    const request = delivery(name, JSON.stringify({ repository, sender, ...payload }), name)
    assert.equal((await server.inject(request)).statusCode, 202)
  }
  const observed = events.map(({ kind, action, headSha, pullRequestNumber, url }) => [
    kind,
    action,
    headSha,
    pullRequestNumber,
    url,
  ])
  const checksUrl = `https://github.com/Example/Bot/commit/${head}/checks`
  assert.deepEqual(observed, [
    ['pull_request', 'synchronize', head, 9, 'https://github.com/Example/Bot/pull/9'],
    ['ci', 'completed', head, 9, checksUrl],
    ['ci', 'completed', head, 9, checksUrl],
    ['ci', 'completed', head, 9, 'https://github.com/Example/Bot/actions/runs/25'],
    ['ci', 'failure', head, undefined, checksUrl],
  ])
})

await test('bounds body size and returns a retryable failure when persistence throws', async (t) => {
  const server = createGitHubWebhookServer({
    secret,
    repository: 'example/bot',
    receive() {
      throw new Error('private database details')
    },
  })
  t.after(() => server.close())
  assert.equal(
    (await server.inject(delivery('ping', 'x'.repeat(2 * 1024 * 1024 + 1)))).statusCode,
    413,
  )
  const response = await server.inject(
    delivery('star', JSON.stringify({ repository, action: 'created' })),
  )
  assert.equal(response.statusCode, 503)
  assert.equal(response.body, '')
})
