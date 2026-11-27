import { setTimeout as wait } from 'node:timers/promises'
import {
  GitHubActivityPollError,
  type GitHubNotificationsQuery,
  type PullRequestActivityQuery,
} from './github-activity.ts'
import type { CiObservation, GitHubAlertStore } from './github-alert-store.ts'
import type { GitHubStarQueries } from './github-stars.ts'
import type { GitHubWebhookEvent } from './github-webhook.ts'
import type { PullRequestChecksQuery } from './github.ts'
import type { AlertDelivery, AlertToDeliver } from './lark-alert-delivery.ts'

const inboxIntervalMs = 60_000
const idleDeliveryMs = 5_000
const webhookIntervalMs = 3_000
const starIntervalMs = 5 * 60_000
const starBatchSize = 8
const retryDelaysMs = [15_000, 30_000, 60_000]
const failedCheckResults = new Set([
  'failure',
  'error',
  'timed_out',
  'startup_failure',
  'action_required',
])

interface AlertWorkerOptions {
  store: GitHubAlertStore
  recipientOpenId: string
  queryCi?: PullRequestActivityQuery
  queryChecks?: PullRequestChecksQuery
  queryInbox?: GitHubNotificationsQuery
  queryStars?: GitHubStarQueries
  webhookRepository?: string
  send: (alert: AlertToDeliver) => Promise<AlertDelivery>
  now?: () => number
  report?: (stage: string, fields: Record<string, number | string>) => void
}

function matchesPullRequest(
  event: GitHubWebhookEvent,
  pullRequest: { repository: string; number: number },
) {
  return (
    event.repository.toLowerCase() === pullRequest.repository.toLowerCase() &&
    (event.pullRequestNumber === undefined || event.pullRequestNumber === pullRequest.number)
  )
}

export function createGitHubAlertWorker(options: AlertWorkerOptions) {
  const {
    store,
    recipientOpenId,
    queryCi,
    queryChecks,
    queryInbox,
    queryStars,
    webhookRepository,
    send,
    report,
  } = options
  const now = options.now ?? Date.now
  let login: string | undefined
  let ciQueue = Promise.resolve()

  function refreshCi(events?: readonly GitHubWebhookEvent[]) {
    const query = queryCi
    if (!query) return
    const refresh = ciQueue.then(async () => {
      const startedAt = now()
      const result = await query(store.getInboxTrackedPullRequests())
      login = result.login
      const pullRequests = events
        ? result.pullRequests.filter((pr) =>
            events.some(
              (event) =>
                matchesPullRequest(event, pr) &&
                (!event.headSha || event.headSha.toLowerCase() === pr.headSha.toLowerCase()),
            ),
          )
        : result.pullRequests
      const observations = new Map<CiObservation, CiObservation | undefined>()
      if (queryChecks) {
        const candidates = store.getCiFailureCandidates(pullRequests, startedAt)
        await Promise.all(
          candidates.slice(0, 6).map(async (item) => {
            const detail = await queryChecks(item.repository, item.number).catch(() => null)
            if (!detail) return
            if (detail.headRefOid !== item.headSha) {
              observations.set(item, undefined)
              return
            }
            const checks = detail.entries
              .filter((entry) =>
                failedCheckResults.has(
                  (entry.kind === 'check_run' ? entry.conclusion : entry.status) ?? '',
                ),
              )
              .slice(0, 5)
              .map(({ name, url }) => ({ name, url: url ?? undefined }))
            observations.set(item, { ...item, checks })
          }),
        )
      }
      const current = pullRequests.flatMap((item) => {
        if (!observations.has(item)) return [item]
        const updated = observations.get(item)
        return updated ? [updated] : []
      })
      const queued = store.observeCi(current, recipientOpenId, startedAt)
      report?.(events ? 'ci_refreshed_from_webhook' : 'ci_polled', {
        observed: current.length,
        queued,
        unavailable: result.unavailableRepositories.length + result.unavailablePullRequests.length,
      })
      return result
    })
    ciQueue = refresh.then(
      () => undefined,
      () => undefined,
    )
    return refresh
  }

  return {
    async pollCi() {
      await refreshCi()
    },
    async pollStars(signal?: AbortSignal) {
      if (!queryStars) return
      const listedAt = now()
      const repositories = await queryStars.listRepositories(signal)
      const delegatedRepository = webhookRepository?.toLowerCase()
      const targets = [
        ...new Map(repositories.map((entry) => [entry.repository.toLowerCase(), entry])).values(),
      ].filter(({ repository }) => repository.toLowerCase() !== delegatedRepository)
      let observed = 0
      let unavailable = 0
      let queued = 0
      let retryAfterMs = 0
      for (let offset = 0; offset < targets.length; offset += starBatchSize) {
        signal?.throwIfAborted()
        const results = await Promise.allSettled(
          targets.slice(offset, offset + starBatchSize).map(async ({ repository, starCount }) => {
            const startedAt = starCount === undefined ? now() : listedAt
            const count = starCount ?? (await queryStars.readStarCount(repository, signal))
            signal?.throwIfAborted()
            return store.observeStarCount(repository, count, recipientOpenId, startedAt)
          }),
        )
        for (const result of results) {
          if (result.status === 'fulfilled') {
            observed++
            queued += result.value
          } else {
            unavailable++
            if (result.reason instanceof GitHubActivityPollError) {
              retryAfterMs = Math.max(retryAfterMs, result.reason.retryAfterMs ?? 0)
            }
          }
        }
        if (retryAfterMs > 0) break
      }
      signal?.throwIfAborted()
      report?.('stars_polled', { repositories: targets.length, observed, unavailable, queued })
      if (retryAfterMs > 0) {
        throw new GitHubActivityPollError('GitHub Star polling was rate limited.', retryAfterMs)
      }
    },
    async processWebhooks() {
      if (!webhookRepository) return
      const pending = store.getPendingWebhooks(now(), webhookRepository)
      const refreshes = pending.filter(({ deliveryId, event }) => {
        if (event.kind === 'ci' || event.kind === 'pull_request') return true
        store.completeWebhook(deliveryId, now(), recipientOpenId)
        return false
      })
      if (!refreshes.length) return

      try {
        const result = await refreshCi(refreshes.map(({ event }) => event))
        if (!result) return
        const unavailable = new Set(
          result.unavailableRepositories.map((repo) => repo.toLowerCase()),
        )
        for (const { deliveryId, event } of refreshes) {
          if (
            unavailable.has(event.repository.toLowerCase()) ||
            result.unavailablePullRequests.some((pr) => matchesPullRequest(event, pr))
          ) {
            store.deferWebhook(deliveryId, now())
          } else {
            store.completeWebhook(deliveryId, now())
          }
        }
      } catch (error) {
        for (const { deliveryId } of refreshes) store.deferWebhook(deliveryId, now())
        throw error
      }
    },
    async pollInbox() {
      if (!queryInbox || !login) return idleDeliveryMs
      const previous = store.getInboxCursor()
      const interval = Math.max(inboxIntervalMs, previous?.pollIntervalMs ?? 0)
      const startedAt = now()
      const waitFor = (previous?.lastPollAtMs ?? startedAt - interval) + interval - startedAt
      if (waitFor > 0) return waitFor

      const result = await queryInbox(login, previous)
      const queued = store.observeInbox(
        result.items,
        result.cursor,
        recipientOpenId,
        startedAt,
        result.trackedPullRequests,
      )
      report?.('inbox_polled', { observed: result.items.length, queued })
      return Math.max(inboxIntervalMs, result.cursor.pollIntervalMs ?? 0)
    },
    async deliver() {
      const alert = store.claimDue(now())
      if (!alert) return idleDeliveryMs
      if (alert.recipientOpenId !== recipientOpenId) {
        store.markFailed(alert.id, 'recipient_mismatch')
        report?.('delivery', { id: alert.id, result: 'failed', reason: 'recipient_mismatch' })
        return 500
      }

      let result: AlertDelivery
      try {
        result = await send(alert)
      } catch {
        result = { kind: 'unknown', reason: 'sender_interrupted' }
      }
      switch (result.kind) {
        case 'sent':
          store.markSent(alert.id, now())
          break
        case 'retry': {
          const backoff = retryDelaysMs[alert.attempts - 1]
          if (backoff !== undefined) {
            const delay = Math.max(backoff, result.retryAfterMs ?? 0)
            store.markRetry(alert.id, now() + delay, result.reason)
          } else {
            store.markFailed(alert.id, result.reason)
          }
          break
        }
        case 'failed':
          store.markFailed(alert.id, result.reason)
          break
        case 'unknown':
          store.markUnknown(alert.id, result.reason)
          break
      }
      report?.('delivery', {
        id: alert.id,
        attempts: alert.attempts,
        result: result.kind,
        ...(result.kind === 'sent' ? {} : { reason: result.reason }),
      })
      return 500
    },
  }
}

export async function runGitHubAlerts(
  options: AlertWorkerOptions & {
    signal: AbortSignal
    ciIntervalMs: number
    starIntervalMs?: number
  },
) {
  const worker = createGitHubAlertWorker(options)
  const { signal, report, ciIntervalMs } = options
  const run = async (
    stage: string,
    action: () => Promise<number | void>,
    defaultInterval: number,
  ) => {
    while (!signal.aborted) {
      let delay = defaultInterval
      try {
        delay = (await action()) ?? defaultInterval
      } catch (error) {
        if (error instanceof GitHubActivityPollError) {
          delay = Math.max(delay, error.retryAfterMs ?? 0)
          if (!signal.aborted) report?.('worker_failed', { stage, reason: error.message })
        } else if (!signal.aborted) {
          report?.('worker_failed', { stage })
        }
      }
      if (!signal.aborted)
        await wait(Math.min(delay, 2_147_483_647), undefined, { signal, ref: false }).catch(
          () => {},
        )
    }
  }

  await Promise.all([
    options.queryCi ? run('ci', () => worker.pollCi(), ciIntervalMs) : undefined,
    options.queryInbox ? run('inbox', () => worker.pollInbox(), inboxIntervalMs) : undefined,
    options.queryStars
      ? run('stars', () => worker.pollStars(signal), options.starIntervalMs ?? starIntervalMs)
      : undefined,
    options.webhookRepository
      ? run('webhook', () => worker.processWebhooks(), webhookIntervalMs)
      : undefined,
    run('delivery', () => worker.deliver(), idleDeliveryMs),
  ])
}
