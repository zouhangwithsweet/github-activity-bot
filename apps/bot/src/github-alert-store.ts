import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { GitHubNotificationCursor } from './github-activity.ts'
import type { GitHubWebhookEvent } from './github-webhook.ts'
import { isRepositoryName, type CheckState } from './github.ts'

export interface CiObservation {
  repository: string
  number: number
  title: string
  url: string
  headSha: string
  state: CheckState | null
  checks?: readonly { name: string; url?: string }[]
}

export interface GitHubInboxEntry {
  id: string
  updatedAt: string
  reason: string
  title: string
  url: string
  repository: string
}

export interface InboxTrackedPullRequest {
  repository: string
  number: number
}

export interface GitHubAlert {
  id: string
  recipientOpenId: string
  text: string
  attempts: number
}

export interface PendingGitHubWebhook {
  deliveryId: string
  event: GitHubWebhookEvent
  receivedAtMs: number
  attempts: number
}

interface GitHubWebhookRow {
  deliveryId: string
  kind: GitHubWebhookEvent['kind']
  repository: string
  action: string
  headSha: string | null
  pullRequestNumber: number | null
  actor: string | null
  url: string
  receivedAtMs: number
  attempts: number
}

const abandonedDeliveryMs = 10 * 60_000
const maxInboxTrackedPullRequests = 10
const maxPendingWebhooks = 50
const maxWebhookAttempts = 6
const webhookRetryBaseMs = 30_000
const inboxReasonLabels = new Map([
  ['mention', '提到了你'],
  ['team_mention', '提到了你的团队'],
  ['review_requested', '请求你的评审'],
  ['assign', '分配给你'],
  ['comment', '新评论'],
])

function isFailure(state: CheckState | null) {
  return state === 'FAILURE' || state === 'ERROR'
}

function ciAlertText(item: CiObservation) {
  const checks = (item.checks ?? [])
    .slice(0, 5)
    .map(({ name, url }) => (url ? `- ${name} ${url}` : `- ${name}`))
  return [
    `GitHub CI 失败 · ${item.repository}#${item.number}`,
    item.title,
    `提交 ${item.headSha.slice(0, 7)}`,
    ...checks,
    item.url,
  ].join('\n')
}

function inboxAlertText(item: GitHubInboxEntry) {
  return [
    `GitHub 通知 · ${inboxReasonLabels.get(item.reason) ?? item.reason}`,
    `${item.repository} · ${item.title}`,
    item.url,
  ].join('\n')
}

function webhookAlertText(event: GitHubWebhookRow): string | undefined {
  const isStar = event.kind === 'star' && event.action === 'created'
  if (!isStar && event.kind !== 'fork') return
  const title = isStar ? 'GitHub Star' : 'GitHub Fork'
  return [`${title} · ${event.repository}`, ...(event.actor ? [event.actor] : []), event.url].join(
    '\n',
  )
}

export function openGitHubAlertStore(databasePath: string) {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS github_ci_observations (
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        ci_state TEXT,
        observed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (repository, pr_number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS github_inbox_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        etag TEXT,
        last_modified TEXT,
        poll_interval_ms INTEGER,
        observed_at_ms INTEGER NOT NULL,
        covered_through_ms INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS github_inbox_threads (
        thread_id TEXT PRIMARY KEY,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS github_inbox_tracked_prs (
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (repository, pr_number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS github_star_counts (
        repository TEXT PRIMARY KEY,
        star_count INTEGER NOT NULL CHECK (star_count >= 0),
        observed_at_ms INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS github_star_webhook_mode (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        repository TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS github_alert_outbox (
        id TEXT PRIMARY KEY,
        recipient_open_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
        attempts INTEGER NOT NULL DEFAULT 0,
        due_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,
        sent_at_ms INTEGER,
        reason TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS github_alert_outbox_due ON github_alert_outbox (due_at_ms)
        WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS github_alert_outbox_claimed ON github_alert_outbox (claimed_at_ms)
        WHERE status = 'sending';

      CREATE TABLE IF NOT EXISTS github_webhook_inbox (
        delivery_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('star', 'fork', 'pull_request', 'ci')),
        repository TEXT NOT NULL,
        action TEXT NOT NULL,
        head_sha TEXT,
        pr_number INTEGER,
        actor TEXT,
        url TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        due_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        completed_at_ms INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS github_webhook_inbox_due ON github_webhook_inbox (due_at_ms)
        WHERE status = 'pending';
    `)

    function transaction<Result>(work: () => Result): Result {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = work()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }

    transaction(() => {
      const columns = database.prepare('PRAGMA table_info(github_inbox_cursor)').all()
      if (!columns.some(({ name }) => name === 'covered_through_ms')) {
        database.exec('ALTER TABLE github_inbox_cursor ADD COLUMN covered_through_ms INTEGER')
      }
    })

    const getCi = database.prepare(`
      SELECT head_sha AS headSha, ci_state AS state, observed_at_ms AS observedAtMs
      FROM github_ci_observations WHERE repository = ? AND pr_number = ?
    `)
    const saveCi = database.prepare(`
      INSERT INTO github_ci_observations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (repository, pr_number) DO UPDATE SET
        head_sha = excluded.head_sha, ci_state = excluded.ci_state,
        observed_at_ms = excluded.observed_at_ms
    `)
    const getCursor = database.prepare(`
      SELECT etag, last_modified AS lastModified, poll_interval_ms AS pollIntervalMs,
             observed_at_ms AS lastPollAtMs, covered_through_ms AS coveredThroughMs
      FROM github_inbox_cursor WHERE singleton = 1
    `)
    const saveCursor = database.prepare(`
      INSERT INTO github_inbox_cursor
        (singleton, etag, last_modified, poll_interval_ms, observed_at_ms, covered_through_ms)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT (singleton) DO UPDATE SET
        etag = excluded.etag, last_modified = excluded.last_modified,
        poll_interval_ms = excluded.poll_interval_ms, observed_at_ms = excluded.observed_at_ms,
        covered_through_ms = excluded.covered_through_ms
    `)
    const seeInboxThread = database.prepare(`
      INSERT INTO github_inbox_threads VALUES (?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms
      WHERE excluded.updated_at_ms > github_inbox_threads.updated_at_ms
    `)
    const trackInboxPullRequest = database.prepare(`
      INSERT INTO github_inbox_tracked_prs VALUES (?, ?, ?, ?)
      ON CONFLICT (repository, pr_number) DO UPDATE SET
        observed_at_ms = excluded.observed_at_ms, position = excluded.position
      WHERE excluded.observed_at_ms > github_inbox_tracked_prs.observed_at_ms
    `)
    const recentInboxPullRequests = database.prepare(`
      SELECT repository, pr_number AS number FROM github_inbox_tracked_prs
      ORDER BY observed_at_ms DESC, position LIMIT ?
    `)
    const pruneInboxPullRequests = database.prepare(`
      DELETE FROM github_inbox_tracked_prs WHERE rowid IN (
        SELECT rowid FROM github_inbox_tracked_prs
        ORDER BY observed_at_ms DESC, position LIMIT -1 OFFSET ?
      )
    `)
    const getStarCount = database.prepare(`
      SELECT star_count AS starCount, observed_at_ms AS observedAtMs
      FROM github_star_counts WHERE repository = ?
    `)
    const saveStarCount = database.prepare(`
      INSERT INTO github_star_counts (repository, star_count, observed_at_ms) VALUES (?, ?, ?)
      ON CONFLICT (repository) DO UPDATE SET
        star_count = excluded.star_count, observed_at_ms = excluded.observed_at_ms
    `)
    const getStarWebhookMode = database.prepare(`
      SELECT repository FROM github_star_webhook_mode WHERE singleton = 1
    `)
    const setStarWebhookMode = database.prepare(`
      INSERT INTO github_star_webhook_mode VALUES (1, ?)
      ON CONFLICT (singleton) DO UPDATE SET repository = excluded.repository
    `)
    const resetLegacyStarCounts = database.prepare(`
      DELETE FROM github_star_counts WHERE repository = ?
      OR EXISTS (
        SELECT 1 FROM github_webhook_inbox
        WHERE repository = github_star_counts.repository COLLATE NOCASE
          AND kind = 'star' AND action = 'created' AND status = 'complete'
          AND completed_at_ms >= github_star_counts.observed_at_ms
      )
    `)
    const resetStarCount = database.prepare('DELETE FROM github_star_counts WHERE repository = ?')
    const completePriorStarReceipts = database.prepare(`
      UPDATE github_webhook_inbox
      SET status = 'complete', completed_at_ms = ?
      WHERE repository = ? COLLATE NOCASE AND kind = 'star' AND status = 'pending'
    `)
    const queue = database.prepare(`
      INSERT INTO github_alert_outbox (id, recipient_open_id, text, status, due_at_ms)
      VALUES (?, ?, ?, 'pending', ?)
    `)
    const abandonStale = database.prepare(`
      UPDATE github_alert_outbox SET status = 'unknown', reason = 'interrupted_delivery'
      WHERE status = 'sending' AND claimed_at_ms <= ?
    `)
    const claim = database.prepare(`
      UPDATE github_alert_outbox
      SET status = 'sending', attempts = attempts + 1, claimed_at_ms = ?
      WHERE id = (
        SELECT id FROM github_alert_outbox
        WHERE status = 'pending' AND due_at_ms <= ?
        ORDER BY due_at_ms, rowid LIMIT 1
      )
      RETURNING id, recipient_open_id AS recipientOpenId, text, attempts
    `)
    const markSent = database.prepare(`
      UPDATE github_alert_outbox SET status = 'sent', sent_at_ms = ?, reason = NULL
      WHERE id = ? AND status IN ('sending', 'unknown')
    `)
    const markRetry = database.prepare(`
      UPDATE github_alert_outbox SET status = 'pending', due_at_ms = ?, reason = ?
      WHERE id = ? AND status = 'sending'
    `)
    const finish = database.prepare(`
      UPDATE github_alert_outbox SET status = ?, reason = ?
      WHERE id = ? AND status = 'sending'
    `)
    const webhookFields = `
      delivery_id AS deliveryId, kind, repository, action, head_sha AS headSha,
      pr_number AS pullRequestNumber, actor, url, received_at_ms AS receivedAtMs, attempts
    `
    const insertWebhook = database.prepare(`
      INSERT INTO github_webhook_inbox
        (delivery_id, kind, repository, action, head_sha, pr_number, actor, url, received_at_ms, due_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (delivery_id) DO NOTHING
    `)
    const pendingWebhooks = database.prepare(`
      SELECT ${webhookFields} FROM github_webhook_inbox
      WHERE status = 'pending' AND due_at_ms <= ?
        AND (? IS NULL OR repository = ? COLLATE NOCASE)
      ORDER BY due_at_ms, received_at_ms, rowid LIMIT ?
    `)
    const completeWebhook = database.prepare(`
      UPDATE github_webhook_inbox SET status = 'complete', completed_at_ms = ?
      WHERE delivery_id = ? AND status = 'pending'
      RETURNING ${webhookFields}
    `)
    const deferWebhook = database.prepare(`
      UPDATE github_webhook_inbox
      SET status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END,
          due_at_ms = ? + ? * (1 << attempts),
          attempts = attempts + 1
      WHERE delivery_id = ? AND status = 'pending' AND due_at_ms <= ?
    `)

    function getInboxCursor(): (GitHubNotificationCursor & { lastPollAtMs: number }) | undefined {
      const row = getCursor.get() as
        | {
            etag: string | null
            lastModified: string | null
            pollIntervalMs: number | null
            lastPollAtMs: number
            coveredThroughMs: number | null
          }
        | undefined
      if (!row) return
      const { etag, lastModified, pollIntervalMs, lastPollAtMs, coveredThroughMs } = row
      return {
        lastPollAtMs,
        ...(etag === null ? {} : { etag }),
        ...(lastModified === null ? {} : { lastModified }),
        ...(pollIntervalMs === null ? {} : { pollIntervalMs }),
        ...(coveredThroughMs === null ? {} : { coveredThroughMs }),
      }
    }

    function ciChange(item: CiObservation, nowMs: number) {
      const repository = item.repository.toLowerCase()
      const previous = getCi.get(repository, item.number) as
        | { headSha: string; state: CheckState | null; observedAtMs: number }
        | undefined
      if (previous && nowMs <= previous.observedAtMs) return

      const headChanged = previous?.headSha !== item.headSha
      const state = previous && !headChanged && item.state === null ? previous.state : item.state
      const notify = previous && isFailure(state) && (headChanged || !isFailure(previous.state))
      return { repository, state, notify }
    }

    return {
      getCiFailureCandidates(items: readonly CiObservation[], nowMs: number): CiObservation[] {
        return items.filter((item) => ciChange(item, nowMs)?.notify)
      },
      observeCi(items: readonly CiObservation[], recipientOpenId: string, nowMs: number): number {
        return transaction(() => {
          let created = 0
          for (const item of items) {
            const change = ciChange(item, nowMs)
            if (!change) continue
            saveCi.run(change.repository, item.number, item.headSha, change.state, nowMs)
            if (change.notify) {
              queue.run(randomUUID(), recipientOpenId, ciAlertText(item), nowMs)
              created += 1
            }
          }
          return created
        })
      },
      observeInbox(
        items: readonly GitHubInboxEntry[],
        cursor: GitHubNotificationCursor,
        recipientOpenId: string,
        nowMs: number,
        tracked: readonly InboxTrackedPullRequest[] = [],
      ): number {
        return transaction(() => {
          const previous = getInboxCursor()
          if (previous && nowMs <= previous.lastPollAtMs) return 0

          let created = 0
          // GitHub may surface the same thread more than once while paginating.
          const latestByThread = new Map<string, { item: GitHubInboxEntry; time: number }>()
          for (const item of items) {
            const time = Date.parse(item.updatedAt)
            if (
              !Number.isFinite(time) ||
              time <= (latestByThread.get(item.id)?.time ?? -Infinity)
            ) {
              continue
            }
            latestByThread.set(item.id, { item, time })
          }
          for (const [id, { item, time }] of latestByThread) {
            const result = seeInboxThread.run(id, time)
            if (previous && result.changes) {
              queue.run(randomUUID(), recipientOpenId, inboxAlertText(item), nowMs)
              created += 1
            }
          }
          tracked.forEach((pullRequest, position) => {
            trackInboxPullRequest.run(
              pullRequest.repository.toLowerCase(),
              pullRequest.number,
              nowMs,
              position,
            )
          })
          if (tracked.length) pruneInboxPullRequests.run(maxInboxTrackedPullRequests)
          saveCursor.run(
            cursor.etag ?? null,
            cursor.lastModified ?? null,
            cursor.pollIntervalMs ?? null,
            nowMs,
            cursor.coveredThroughMs ?? null,
          )
          return created
        })
      },
      getInboxCursor,
      getInboxTrackedPullRequests(): InboxTrackedPullRequest[] {
        return recentInboxPullRequests.all(maxInboxTrackedPullRequests).map((row) => ({
          repository: row.repository as string,
          number: row.number as number,
        }))
      },
      configureStarWebhook(repository: string | undefined, enabled: boolean, nowMs: number) {
        const repositoryKey = repository?.toLowerCase() ?? null
        const webhook = enabled ? repositoryKey : null
        transaction(() => {
          const previous = getStarWebhookMode.get()
          // Older releases paused Star polling whenever a webhook was configured.
          if (!previous) resetLegacyStarCounts.run(repositoryKey)
          if (webhook && previous && previous.repository !== webhook) {
            completePriorStarReceipts.run(nowMs, webhook)
          }
          setStarWebhookMode.run(webhook)
          if (webhook) resetStarCount.run(webhook)
        })
      },
      observeStarCount(
        repository: string,
        starCount: number,
        recipientOpenId: string,
        observedAtMs: number,
      ): number {
        if (!isRepositoryName(repository))
          throw new Error('Expected a GitHub repository as owner/repo.')
        if (!Number.isSafeInteger(starCount) || starCount < 0) {
          throw new Error('Expected a nonnegative integer Star count.')
        }
        return transaction(() => {
          const repositoryKey = repository.toLowerCase()
          if (getStarWebhookMode.get()?.repository === repositoryKey) return 0
          const previous = getStarCount.get(repositoryKey) as
            | { starCount: number; observedAtMs: number }
            | undefined
          if (previous && observedAtMs <= previous.observedAtMs) return 0

          saveStarCount.run(repositoryKey, starCount, observedAtMs)
          if (!previous || starCount <= previous.starCount) return 0
          const message = [
            `GitHub Star · ${repository}`,
            `净增 ${starCount - previous.starCount} · 当前 ${starCount}`,
            `https://github.com/${repository}`,
          ].join('\n')
          queue.run(randomUUID(), recipientOpenId, message, observedAtMs)
          return 1
        })
      },
      receiveWebhook(deliveryId: string, event: GitHubWebhookEvent, nowMs: number): boolean {
        return Boolean(
          insertWebhook.run(
            deliveryId,
            event.kind,
            event.repository,
            event.action,
            event.headSha ?? null,
            event.pullRequestNumber ?? null,
            event.actor ?? null,
            event.url,
            nowMs,
            nowMs,
          ).changes,
        )
      },
      getPendingWebhooks(nowMs: number, repository?: string): PendingGitHubWebhook[] {
        const selected = repository ?? null
        const rows = pendingWebhooks.all(
          nowMs,
          selected,
          selected,
          maxPendingWebhooks,
        ) as (GitHubWebhookRow & Record<string, unknown>)[]
        return rows.map(
          ({
            deliveryId,
            receivedAtMs,
            attempts,
            headSha,
            pullRequestNumber,
            actor,
            kind,
            repository,
            action,
            url,
          }) => ({
            deliveryId,
            receivedAtMs,
            attempts,
            event: {
              kind,
              repository,
              action,
              url,
              ...(headSha === null ? {} : { headSha }),
              ...(pullRequestNumber === null ? {} : { pullRequestNumber }),
              ...(actor === null ? {} : { actor }),
            },
          }),
        )
      },
      completeWebhook(deliveryId: string, nowMs: number, recipientOpenId?: string): boolean {
        return transaction(() => {
          const event = completeWebhook.get(nowMs, deliveryId) as GitHubWebhookRow | undefined
          if (!event) return false
          const starWebhookMode = getStarWebhookMode.get()
          if (
            event.kind === 'star' &&
            starWebhookMode &&
            starWebhookMode.repository !== event.repository.toLowerCase()
          ) {
            return true
          }
          const text = webhookAlertText(event)
          if (recipientOpenId && text) queue.run(randomUUID(), recipientOpenId, text, nowMs)
          return true
        })
      },
      deferWebhook(deliveryId: string, nowMs: number): boolean {
        return Boolean(
          deferWebhook.run(maxWebhookAttempts, nowMs, webhookRetryBaseMs, deliveryId, nowMs)
            .changes,
        )
      },
      claimDue(nowMs: number): GitHubAlert | undefined {
        return transaction(() => {
          abandonStale.run(nowMs - abandonedDeliveryMs)
          const alert = claim.get(nowMs, nowMs) as GitHubAlert | undefined
          return alert && { ...alert }
        })
      },
      markSent(id: string, nowMs: number) {
        markSent.run(nowMs, id)
      },
      markRetry(id: string, nextAttemptAt: number, reason: string) {
        markRetry.run(nextAttemptAt, reason, id)
      },
      markFailed(id: string, reason: string) {
        finish.run('failed', reason, id)
      },
      markUnknown(id: string, reason: string) {
        finish.run('unknown', reason, id)
      },
      close() {
        if (database.isOpen) database.close()
      },
    }
  } catch (error) {
    database.close()
    throw error
  }
}

export type GitHubAlertStore = ReturnType<typeof openGitHubAlertStore>
