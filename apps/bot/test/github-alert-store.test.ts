import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import {
  openGitHubAlertStore,
  type CiObservation,
  type GitHubInboxEntry,
} from '../src/github-alert-store.ts'
import type { GitHubWebhookEvent } from '../src/github-webhook.ts'

const owner = 'ou_owner'
const repository = 'Example/Bot'
const pullRequestUrl = 'https://github.com/Example/Bot/pull/42'
const headSha = '1'.repeat(40)

function scratchDatabase(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'github-alert-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'state.sqlite')
}

function ci(state: CiObservation['state'], extra: Partial<CiObservation> = {}): CiObservation {
  return {
    repository,
    number: 42,
    title: 'Repair the bot',
    url: pullRequestUrl,
    headSha,
    state,
    ...extra,
  }
}

function inbox(updatedAt: string, extra: Partial<GitHubInboxEntry> = {}): GitHubInboxEntry {
  return {
    id: 'thread-42',
    updatedAt,
    reason: 'review_requested',
    title: 'Repair the bot',
    url: pullRequestUrl,
    repository,
    ...extra,
  }
}

await test('baselines CI and queues only newer failure transitions across restarts', (t) => {
  const path = scratchDatabase(t)
  let store = openGitHubAlertStore(path)
  try {
    const failed = ci('FAILURE')
    const newHead = '2'.repeat(40)
    assert.deepEqual(store.getCiFailureCandidates([failed], 100), [])
    assert.equal(store.observeCi([failed], owner, 100), 0)
    assert.equal(store.observeCi([ci('ERROR')], owner, 110), 0)
    assert.equal(store.claimDue(110), undefined)
    const newFailure = ci('FAILURE', {
      repository: repository.toLowerCase(),
      headSha: newHead,
      checks: [{ name: 'unit tests', url: 'https://github.com/Example/Bot/actions/runs/123' }],
    })
    assert.deepEqual(store.getCiFailureCandidates([newFailure], 110), [])
    assert.deepEqual(store.getCiFailureCandidates([newFailure], 120), [newFailure])
    assert.equal(store.observeCi([newFailure], owner, 120), 1)
    assert.deepEqual(store.getCiFailureCandidates([newFailure], 121), [])
    assert.equal(store.observeCi([ci('PENDING')], owner, 115), 0)
    assert.equal(store.observeCi([ci('SUCCESS', { headSha: newHead })], owner, 120), 0)
    store.close()

    store = openGitHubAlertStore(path)
    assert.equal(store.observeCi([ci(null, { headSha: newHead })], owner, 130), 0)
    assert.equal(store.observeCi([ci('FAILURE', { headSha: newHead })], owner, 140), 0)
    const alert = store.claimDue(140)
    assert.ok(alert)
    assert.match(alert.id, /^[0-9a-f-]{36}$/)
    assert.equal(alert.recipientOpenId, owner)
    assert.equal(alert.attempts, 1)
    assert.match(alert.text, /CI 失败.*example\/bot#42/)
    assert.match(alert.text, /2222222/)
    assert.match(alert.text, /unit tests/)
    assert.ok(alert.text.includes(pullRequestUrl))
    store.markSent(alert.id, 140)
    assert.equal(store.claimDue(140), undefined)

    assert.equal(store.observeCi([ci('SUCCESS', { headSha: newHead })], owner, 150), 0)
    assert.equal(store.observeCi([ci('ERROR', { headSha: newHead })], owner, 160), 1)
    assert.equal(store.observeCi([ci('FAILURE', { headSha: newHead })], owner, 170), 0)
    assert.ok(store.claimDue(170))
    assert.equal(store.claimDue(170), undefined)
  } finally {
    store.close()
  }
})

await test('persists inbox versions, cursor, and most recent PR refs together', (t) => {
  const path = scratchDatabase(t)
  let store = openGitHubAlertStore(path)
  try {
    const first = inbox('2026-11-26T02:00:00Z')
    const second = inbox('2026-11-26T03:00:00Z')
    const newer = inbox('2026-11-26T04:00:00Z')
    assert.equal(store.getInboxCursor(), undefined)
    assert.equal(
      store.observeInbox([first], { etag: 'first', pollIntervalMs: 60_000 }, owner, 100),
      0,
    )
    assert.equal(
      store.observeInbox(
        [first, second, newer],
        { etag: 'second', lastModified: 'Thu, 26 Nov 2026 04:00:00 GMT', pollIntervalMs: 90_000 },
        owner,
        200,
        Array.from({ length: 12 }, (_, i) => ({ repository, number: i + 1 })),
      ),
      1,
    )
    assert.equal(store.observeInbox([newer], { etag: 'old-attempt' }, owner, 199), 0)
    store.close()

    store = openGitHubAlertStore(path)
    assert.deepEqual(store.getInboxCursor(), {
      etag: 'second',
      lastModified: 'Thu, 26 Nov 2026 04:00:00 GMT',
      pollIntervalMs: 90_000,
      lastPollAtMs: 200,
    })
    assert.deepEqual(
      store.getInboxTrackedPullRequests(),
      Array.from({ length: 10 }, (_, i) => ({
        repository: repository.toLowerCase(),
        number: i + 1,
      })),
    )
    assert.equal(
      store.observeInbox(
        [second, newer, inbox('2026-11-26T04:00:00.000+00:00')],
        { etag: 'third' },
        owner,
        300,
        [
          { repository: 'Example/Other', number: 42 },
          { repository: 'EXAMPLE/BOT', number: 2 },
        ],
      ),
      0,
    )
    assert.deepEqual(store.getInboxTrackedPullRequests().slice(0, 2), [
      { repository: 'example/other', number: 42 },
      { repository: 'example/bot', number: 2 },
    ])
    const alert = store.claimDue(300)
    assert.ok(alert)
    assert.match(alert.text, /请求你的评审/)
    assert.match(alert.text, /Repair the bot/)
    assert.equal(store.claimDue(300), undefined)
  } finally {
    store.close()
  }
})

await test('claims once, retries at the due time, and leaves interrupted sends unknown', (t) => {
  const path = scratchDatabase(t)
  let store = openGitHubAlertStore(path)
  const peer = openGitHubAlertStore(path)
  try {
    assert.equal(store.observeCi([ci('SUCCESS')], owner, 100), 0)
    assert.equal(store.observeCi([ci('FAILURE')], owner, 200), 1)
    const first = store.claimDue(200)
    assert.ok(first)
    assert.equal(peer.claimDue(200), undefined)
    store.markRetry(first.id, 500, 'rate_limited')
    assert.equal(peer.claimDue(499), undefined)
    const retry = peer.claimDue(500)
    assert.equal(retry?.id, first.id)
    assert.equal(retry.attempts, 2)
    store.close()

    store = openGitHubAlertStore(path)
    const restart = 500 + 10 * 60_000
    assert.equal(store.claimDue(restart), undefined)
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const row = database
        .prepare('SELECT status, reason FROM github_alert_outbox WHERE id = ?')
        .get(first.id)
      assert.equal(row?.status, 'unknown')
      assert.equal(row.reason, 'interrupted_delivery')
      store.markRetry(first.id, restart + 1, 'rate_limited')
      assert.equal(peer.claimDue(restart + 1), undefined)

      assert.equal(store.observeCi([ci('FAILURE', { headSha: '3'.repeat(40) })], owner, restart), 1)
      const failed = store.claimDue(restart)
      assert.ok(failed)
      store.markFailed(failed.id, 'permission_denied')
      assert.equal(peer.claimDue(restart), undefined)
      assert.equal(
        database.prepare('SELECT status FROM github_alert_outbox WHERE id = ?').get(failed.id)
          ?.status,
        'failed',
      )
    } finally {
      database.close()
    }
  } finally {
    peer.close()
    store.close()
  }
})

await test('rolls back CI observations together with their notifications', (t) => {
  const store = openGitHubAlertStore(scratchDatabase(t))
  try {
    assert.equal(store.observeCi([ci('SUCCESS')], owner, 100), 0)
    assert.throws(() =>
      store.observeCi([ci('FAILURE'), ci('FAILURE', { number: 42.5 })], owner, 200),
    )
    assert.equal(store.claimDue(200), undefined)
    assert.equal(store.observeCi([ci('FAILURE')], owner, 300), 1)
    assert.ok(store.claimDue(300))
  } finally {
    store.close()
  }
})

await test('deduplicates webhook receipts and atomically queues one star or fork alert', (t) => {
  const path = scratchDatabase(t)
  let store = openGitHubAlertStore(path)
  const peer = openGitHubAlertStore(path)
  const star: GitHubWebhookEvent = {
    kind: 'star',
    action: 'created',
    repository,
    actor: 'octocat',
    url: 'https://github.com/Example/Bot',
  }
  try {
    assert.equal(store.receiveWebhook('star-delivery', star, 100), true)
    assert.equal(peer.receiveWebhook('star-delivery', { ...star, actor: 'other' }, 150), false)
    assert.deepEqual(store.getPendingWebhooks(99), [])
    assert.deepEqual(peer.getPendingWebhooks(100), [
      { deliveryId: 'star-delivery', event: star, receivedAtMs: 100, attempts: 0 },
    ])
    assert.equal(store.claimDue(100), undefined)
    store.close()

    store = openGitHubAlertStore(path)
    assert.equal(store.completeWebhook('star-delivery', 200, owner), true)
    assert.equal(peer.completeWebhook('star-delivery', 200, owner), false)
    assert.equal(peer.receiveWebhook('star-delivery', star, 200), false)
    assert.deepEqual(peer.getPendingWebhooks(200), [])
    const starAlert = peer.claimDue(200)
    assert.ok(starAlert)
    assert.equal(starAlert.recipientOpenId, owner)
    assert.match(starAlert.text, /GitHub Star.*Example\/Bot/)
    assert.match(starAlert.text, /octocat/)
    peer.markSent(starAlert.id, 200)
    assert.equal(store.claimDue(200), undefined)

    assert.equal(store.receiveWebhook('unstar-delivery', { ...star, action: 'deleted' }, 300), true)
    assert.equal(store.completeWebhook('unstar-delivery', 300, owner), true)
    assert.equal(peer.claimDue(300), undefined)
    assert.equal(
      store.receiveWebhook('fork-delivery', { ...star, kind: 'fork', action: 'forked' }, 400),
      true,
    )
    assert.equal(peer.completeWebhook('fork-delivery', 400, owner), true)
    assert.match(store.claimDue(400)?.text ?? '', /GitHub Fork.*Example\/Bot/)
    assert.equal(peer.claimDue(400), undefined)
  } finally {
    peer.close()
    store.close()
  }
})

await test('persists webhook backoff without duplicating attempts or registering a DM', (t) => {
  const path = scratchDatabase(t)
  let store = openGitHubAlertStore(path)
  const peer = openGitHubAlertStore(path)
  let time = 100
  const ciEvent: GitHubWebhookEvent = {
    kind: 'ci',
    action: 'completed',
    repository,
    headSha,
    pullRequestNumber: 42,
    url: pullRequestUrl,
  }
  try {
    assert.equal(store.receiveWebhook('ci-delivery', ciEvent, time), true)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      assert.deepEqual(peer.getPendingWebhooks(time), [
        { deliveryId: 'ci-delivery', event: ciEvent, receivedAtMs: 100, attempts: attempt },
      ])
      assert.equal(store.deferWebhook('ci-delivery', time), true)
      assert.equal(peer.deferWebhook('ci-delivery', time), false)
      time += 30_000 * 2 ** attempt
      assert.deepEqual(peer.getPendingWebhooks(time - 1), [])
      store.close()
      store = openGitHubAlertStore(path)
    }

    assert.deepEqual(store.getPendingWebhooks(time), [])
    assert.equal(store.receiveWebhook('ci-delivery', ciEvent, time), false)
    assert.equal(peer.completeWebhook('ci-delivery', time, owner), false)
    assert.equal(peer.claimDue(time), undefined)

    assert.equal(store.receiveWebhook('another-ci', ciEvent, time), true)
    assert.equal(peer.completeWebhook('another-ci', time, owner), true)
    const pullRequest: GitHubWebhookEvent = { ...ciEvent, kind: 'pull_request', action: 'opened' }
    assert.equal(store.receiveWebhook('pr-delivery', pullRequest, time), true)
    assert.equal(peer.completeWebhook('pr-delivery', time, owner), true)
    assert.equal(peer.claimDue(time), undefined)
  } finally {
    peer.close()
    store.close()
  }
})

await test('filters due webhooks by repository before applying the batch limit', (t) => {
  const store = openGitHubAlertStore(scratchDatabase(t))
  const star: GitHubWebhookEvent = {
    kind: 'star',
    action: 'created',
    repository,
    actor: 'octocat',
    url: 'https://github.com/Example/Bot',
  }
  try {
    for (let i = 0; i < 50; i += 1) {
      store.receiveWebhook(`previous-${i}`, { ...star, repository: 'Example/Previous' }, 100)
    }
    store.receiveWebhook('selected', star, 200)
    assert.equal(store.getPendingWebhooks(200).length, 50)
    assert.deepEqual(store.getPendingWebhooks(200, 'example/bot'), [
      { deliveryId: 'selected', event: star, receivedAtMs: 200, attempts: 0 },
    ])
    assert.deepEqual(store.getPendingWebhooks(200, 'another/other'), [])
  } finally {
    store.close()
  }
})
