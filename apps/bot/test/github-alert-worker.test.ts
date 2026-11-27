import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PullRequestObservation } from '../src/github-activity.ts'
import { openGitHubAlertStore } from '../src/github-alert-store.ts'
import { createGitHubAlertWorker } from '../src/github-alert-worker.ts'
import { createGitHubWebhookServer } from '../src/github-webhook.ts'
import { createLarkAlertSender } from '../src/lark-alert-delivery.ts'

const owner = 'ou_owner'
const pullRequest = {
  repository: 'example/bot',
  number: 42,
  title: 'Fix CI',
  url: 'https://github.com/example/bot/pull/42',
  headSha: 'a'.repeat(40),
  state: 'PENDING',
} satisfies PullRequestObservation

await test('reopens a signed delivery and shares one current-head CI transition with polling', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'github-webhook-worker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'memory.sqlite')
  let store = openGitHubAlertStore(path)
  let current: PullRequestObservation = pullRequest
  let now = 1_000
  const sent: string[] = []
  const secret = 'local-test-secret'
  const server = createGitHubWebhookServer({
    secret,
    repository: pullRequest.repository,
    receive: (id, event, time) => store.receiveWebhook(id, event, time),
    now: () => now,
  })
  const makeWorker = () =>
    createGitHubAlertWorker({
      store,
      recipientOpenId: owner,
      webhookRepository: pullRequest.repository,
      now: () => now,
      queryCi: async () => ({
        login: 'owner',
        pullRequests: [current],
        unavailableRepositories: [],
        unavailablePullRequests: [],
      }),
      async send(alert) {
        sent.push(alert.text)
        return { kind: 'sent' }
      },
    })
  const injectFailure = (id: string, headSha: string) => {
    const payload = JSON.stringify({
      repository: { full_name: pullRequest.repository },
      state: 'failure',
      sha: headSha,
    })
    return server.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'status',
        'x-github-delivery': id,
        'x-hub-signature-256':
          'sha256=' + createHmac('sha256', secret).update(payload).digest('hex'),
      },
    })
  }

  try {
    await makeWorker().pollCi()
    now += 1
    current = { ...pullRequest, state: 'FAILURE' }
    assert.equal((await injectFailure('delivery-first', pullRequest.headSha)).statusCode, 202)
    store.close()
    store = openGitHubAlertStore(path)

    const resumed = makeWorker()
    now += 1
    await resumed.processWebhooks()
    now += 1
    await resumed.pollCi()
    assert.equal((await injectFailure('delivery-first', pullRequest.headSha)).statusCode, 200)
    await resumed.processWebhooks()
    await resumed.deliver()
    await resumed.deliver()
    assert.equal(sent.length, 1)
    assert.match(sent[0], /aaaaaaa/)

    now += 1
    current = { ...current, headSha: 'b'.repeat(40) }
    assert.equal((await injectFailure('delivery-stale', pullRequest.headSha)).statusCode, 202)
    await resumed.processWebhooks()
    await resumed.deliver()
    assert.equal(sent.length, 1)

    now += 1
    await resumed.pollCi()
    now += 1
    assert.equal((await injectFailure('delivery-current', current.headSha)).statusCode, 202)
    await resumed.processWebhooks()
    await resumed.deliver()
    await resumed.deliver()
    assert.equal(sent.length, 2)
    assert.match(sent[1], /bbbbbbb/)
  } finally {
    await server.close()
    store.close()
  }
})

await test('starts silently, recovers a queued failure across restart, and sends it once with its check link', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'github-alert-worker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'memory.sqlite')
  let store = openGitHubAlertStore(path)
  let current: PullRequestObservation = pullRequest
  let now = 1_000
  let checkedHead = 'b'.repeat(40)
  const delivered: { uuid?: string; text: string }[] = []
  const makeWorker = () =>
    createGitHubAlertWorker({
      store,
      recipientOpenId: owner,
      now: () => now,
      queryCi: async () => ({
        login: 'owner',
        pullRequests: [current],
        unavailableRepositories: [],
        unavailablePullRequests: [],
      }),
      queryChecks: async () => ({
        repository: current.repository,
        number: current.number,
        url: current.url,
        headRefOid: checkedHead,
        coverage: 'complete',
        sources: { checkRuns: 'complete', commitStatuses: 'complete' },
        entries: [
          {
            kind: 'commit_status',
            name: 'unit-tests',
            status: 'failure',
            url: 'https://github.com/example/bot/actions/runs/42',
            updatedAt: '2026-11-27T00:00:00Z',
          },
        ],
      }),
      send: createLarkAlertSender(
        {
          async create(payload) {
            assert.equal(payload?.data.receive_id, owner)
            const content = JSON.parse(payload.data.content) as { text: string }
            delivered.push({ uuid: payload.data.uuid, text: content.text })
            return { code: 0, data: { message_id: 'om_alert' } }
          },
        },
        (text) => text,
      ),
    })

  try {
    const first = makeWorker()
    await first.pollCi()
    await first.deliver()
    assert.equal(delivered.length, 0)

    now += 1
    current = { ...pullRequest, state: 'FAILURE' }
    await first.pollCi()
    await first.deliver()
    assert.equal(delivered.length, 0, 'The failure vanished from the current GitHub head.')

    now += 1
    checkedHead = current.headSha
    await first.pollCi()
    store.close()
    store = openGitHubAlertStore(path)

    const restarted = makeWorker()
    await restarted.deliver()
    now += 1
    await restarted.pollCi()
    await restarted.deliver()
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].uuid ?? '', /^[a-f0-9-]{36}$/)
    assert.match(
      delivered[0].text,
      /unit-tests https:\/\/github\.com\/example\/bot\/actions\/runs\/42/,
    )
  } finally {
    store.close()
  }
})

await test('retries a confirmed pre-TLS disconnect with the same UUID, then holds ambiguous delivery', async (t) => {
  const store = openGitHubAlertStore(':memory:')
  t.after(() => store.close())
  let now = 1_000
  const attempts: (string | undefined)[] = []
  store.observeCi([pullRequest], owner, now)
  now += 1
  store.observeCi([{ ...pullRequest, state: 'FAILURE' }], owner, now)
  const worker = createGitHubAlertWorker({
    store,
    recipientOpenId: owner,
    now: () => now,
    queryCi: async () => assert.fail('Unexpected poll'),
    send: createLarkAlertSender(
      {
        async create(payload) {
          attempts.push(payload?.data.uuid)
          if (attempts.length === 1) {
            throw Object.assign(
              new Error(
                'Client network socket disconnected before secure TLS connection was established',
              ),
              { code: 'ECONNRESET' },
            )
          }
          throw Object.assign(new Error('Connection lost after request'), { code: 'ECONNRESET' })
        },
      },
      (text) => text,
    ),
  })

  await worker.deliver()
  await worker.deliver()
  assert.equal(attempts.length, 1)
  now += 15_000
  await worker.deliver()
  assert.deepEqual(attempts, [attempts[0], attempts[0]])
  now += 600_000
  await worker.deliver()
  assert.equal(attempts.length, 2)
})
