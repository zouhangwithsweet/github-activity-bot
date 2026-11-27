import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLarkChannel, Domain, LarkChannelError, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { CodexAnswerError, openGitHubConversation, type GitHubConversationTools } from './agent.ts'
import {
  createGitHubNotificationsQuery,
  createPullRequestActivityQuery,
} from './github-activity.ts'
import { openGitHubAlertStore } from './github-alert-store.ts'
import { runGitHubAlerts } from './github-alert-worker.ts'
import { createPullRequestMerger } from './github-merge.ts'
import { createPullRequestPreviewQuery } from './github-preview.ts'
import { createGitHubStarQueries } from './github-stars.ts'
import { createGitHubWebhookServer } from './github-webhook.ts'
import {
  createPublicRepositoryQuery,
  createPullRequestChecksQuery,
  createPullRequestDetailQuery,
  createPullRequestQuery,
  createPullRequestReviewsQuery,
  isRepositoryName,
} from './github.ts'
import { createLarkAlertSender } from './lark-alert-delivery.ts'
import { createLarkGroupRouter } from './lark-group.ts'
import { processLarkGroupTurn, trackGroupGitHubAccess } from './lark-group-work.ts'
import {
  answerLarkMessage,
  createLarkConversations,
  openRememberedConversation,
  startLarkProgress,
} from './lark-handler.ts'
import { openLarkMemory } from './lark-memory.ts'
import { createLarkMergeFlow } from './lark-merge.ts'
import { openLarkMergeStore } from './lark-merge-store.ts'
import { normalizeLarkQuote, type GetLarkQuote } from './lark-quote.ts'
import { createPullRequestReview, type PullRequestReviewReport } from './pull-request-review.ts'

async function main() {
  const appId = process.env.LARK_APP_ID?.trim()
  const appSecret = process.env.LARK_APP_SECRET?.trim()
  const ownerOpenId = process.env.LARK_OWNER_OPEN_ID?.trim() ?? ''
  const testGroupId = process.env.LARK_TEST_GROUP_CHAT_ID?.trim()
  const alertsEnabled = process.env.LARK_GITHUB_ALERTS?.trim() === '1'
  const ciPollSeconds = Number(process.env.GH_ACTIVITY_POLL_SECONDS?.trim() || 120)
  const starRepoSource = process.env.GH_STAR_REPO_SOURCE?.trim() || undefined
  const starRepositories = (process.env.GH_STAR_REPOSITORIES ?? '')
    .split(',')
    .map((repository) => repository.trim())
    .filter(Boolean)
  const starsEnabled = Boolean(starRepoSource || starRepositories.length)
  const starPollSeconds = Number(process.env.GH_STAR_POLL_SECONDS?.trim() || 300)
  const webhookSecret = process.env.GH_WEBHOOK_SECRET?.trim()
  const webhookRepository = process.env.GH_WEBHOOK_REPOSITORY?.trim()
  const webhookPort = Number(process.env.GH_WEBHOOK_PORT?.trim() || 8787)
  const configuredQuery = createPullRequestQuery()
  const configuredDetailQuery = createPullRequestDetailQuery()
  const configuredChecksQuery = createPullRequestChecksQuery()
  const configuredReviewsQuery = createPullRequestReviewsQuery()
  const merger = createPullRequestMerger()

  if (!appId || !appSecret)
    throw new Error('Set LARK_APP_ID and LARK_APP_SECRET in the local environment.')
  if (ownerOpenId && !ownerOpenId.startsWith('ou_')) {
    throw new Error('LARK_OWNER_OPEN_ID must be the open_id for this Lark app.')
  }
  if (testGroupId && (!testGroupId.startsWith('oc_') || !ownerOpenId)) {
    throw new Error('Set LARK_TEST_GROUP_CHAT_ID to a group chat_id and set LARK_OWNER_OPEN_ID.')
  }
  if ((alertsEnabled || starsEnabled) && !ownerOpenId) {
    throw new Error('Set LARK_OWNER_OPEN_ID to enable GitHub alerts.')
  }
  if (
    starRepoSource !== undefined &&
    starRepoSource !== 'watched' &&
    starRepoSource !== 'accessible'
  ) {
    throw new Error('GH_STAR_REPO_SOURCE must be watched or accessible.')
  }
  if (starRepositories.some((repository) => !isRepositoryName(repository))) {
    throw new Error('GH_STAR_REPOSITORIES must contain comma-separated owner/repo names.')
  }
  if (
    starsEnabled &&
    (!Number.isInteger(starPollSeconds) || starPollSeconds < 60 || starPollSeconds > 86400)
  ) {
    throw new Error('GH_STAR_POLL_SECONDS must be a whole number between 60 and 86400.')
  }
  if (webhookSecret || webhookRepository) {
    if (
      !alertsEnabled ||
      !webhookSecret ||
      !webhookRepository ||
      !isRepositoryName(webhookRepository)
    ) {
      throw new Error(
        'GitHub Webhooks require LARK_GITHUB_ALERTS=1, GH_WEBHOOK_SECRET, and GH_WEBHOOK_REPOSITORY as owner/repo.',
      )
    }
    if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
      throw new Error('GH_WEBHOOK_PORT must be a whole TCP port between 1 and 65535.')
    }
  }
  if (
    alertsEnabled &&
    (!Number.isInteger(ciPollSeconds) || ciPollSeconds < 30 || ciPollSeconds > 86400)
  ) {
    throw new Error('GH_ACTIVITY_POLL_SECONDS must be a whole number between 30 and 86400.')
  }
  if (
    ownerOpenId &&
    (!configuredQuery ||
      !configuredDetailQuery ||
      !configuredChecksQuery ||
      !configuredReviewsQuery)
  ) {
    throw new Error('Set GH_TOKEN or GH_ORG_TOKEN to enable PR queries.')
  }

  const shutdown = new AbortController()
  const missingGitHubToken = () => Promise.reject(new Error('GitHub token is missing.'))
  const query = configuredQuery ?? missingGitHubToken
  const github = {
    list: query,
    detail: configuredDetailQuery ?? missingGitHubToken,
    checks: configuredChecksQuery ?? missingGitHubToken,
    reviews: configuredReviewsQuery ?? missingGitHubToken,
  }
  const reviewPullRequest = createPullRequestReview({
    detail: github.detail,
    preview: createPullRequestPreviewQuery(),
    signal: shutdown.signal,
  })
  let activeReview: Promise<PullRequestReviewReport> | undefined
  const stateDir =
    process.env.LARK_MEMORY_DIR?.trim() || join(homedir(), '.local', 'state', 'github-activity-bot')
  const queryCi = alertsEnabled ? createPullRequestActivityQuery() : undefined
  const queryInbox = alertsEnabled ? createGitHubNotificationsQuery() : undefined
  const queryStars = starsEnabled
    ? createGitHubStarQueries({
        source: starRepoSource,
        repositories: starRepositories,
      })
    : undefined
  if (starsEnabled && !queryStars) {
    throw new Error('Set GH_TOKEN or GH_ORG_TOKEN to enable Star polling.')
  }
  const memory = ownerOpenId ? openLarkMemory(stateDir, { appId, ownerOpenId }) : undefined
  const openSession = (tools: GitHubConversationTools, resume?: string) =>
    openGitHubConversation(tools, shutdown.signal, memory && { cwd: memory.cwd, resume })
  const conversations = createLarkConversations((chatId) =>
    openRememberedConversation(`dm:${chatId}`, memory, (resume) => openSession(github, resume)),
  )
  const groups = createLarkGroupRouter({
    ownerOpenId,
    allowedChatIds: testGroupId ? [testGroupId] : [],
    memory,
  })
  const publicRepository = createPublicRepositoryQuery()
  const groupConversations = createLarkConversations(async (scope) => {
    const access = trackGroupGitHubAccess(github, publicRepository, memory && { scope, memory })
    return openRememberedConversation(scope, memory, async (resume) => {
      const conversation = await openSession(access.tools, resume)
      return {
        id: conversation.id,
        answer: async (question: string) => {
          const text = await conversation.answer(question)
          return { text, canReplyInGroup: await access.canReplyInGroup() }
        },
        close: conversation.close,
      }
    })
  }, 30 * 60_000)

  const secrets = [
    appSecret,
    process.env.GH_TOKEN?.trim(),
    process.env.GITHUB_TOKEN?.trim(),
    process.env.GH_ORG_TOKEN?.trim(),
    process.env.GH_NOTIFICATIONS_TOKEN?.trim(),
    process.env.GH_MERGE_TOKEN?.trim(),
    webhookSecret,
  ].filter((value): value is string => Boolean(value))
  const redact = (text: string) =>
    secrets.reduce(
      (value, secret) => value.replaceAll(secret, '[redacted]'),
      text.replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]'),
    )

  const channel = createLarkChannel({
    appId,
    appSecret,
    domain: Domain.Lark,
    transport: 'websocket',
    loggerLevel: LoggerLevel.error,
    policy: {
      ...(ownerOpenId ? { dmMode: 'allowlist', dmAllowlist: [ownerOpenId] } : { dmMode: 'open' }),
      ...(testGroupId ? { groupAllowlist: [testGroupId], requireMention: false } : {}),
    },
    // Queue Codex turns ourselves so each incoming message can show progress immediately.
    safety: { chatQueue: { enabled: false } },
  })
  const getQuote = async (chatId: string, messageId: string, chatType: 'p2p' | 'group') => {
    const timeout = Promise.withResolvers<undefined>()
    const timer = setTimeout(() => timeout.resolve(undefined), 8_000).unref()
    try {
      const response = await Promise.race([
        channel.rawClient.im.v1.message.get({ path: { message_id: messageId } }),
        timeout.promise,
      ])
      return normalizeLarkQuote(
        chatId,
        messageId,
        response?.data?.items,
        channel.botIdentity,
        chatType,
      )
    } finally {
      clearTimeout(timer)
    }
  }
  const getPrivateQuote: GetLarkQuote = (chatId, messageId) => getQuote(chatId, messageId, 'p2p')
  const mergeStore = memory && openLarkMergeStore(memory.databasePath)
  const mergeFlow =
    mergeStore &&
    createLarkMergeFlow({
      ownerOpenId,
      detail: github.detail,
      merger,
      store: mergeStore,
      getQuote: getPrivateQuote,
      signal: shutdown.signal,
    })
  const pendingMerges = new Set<Promise<string>>()
  const trackMerge = (result: Promise<string>) => {
    pendingMerges.add(result)
    return result.finally(() => pendingMerges.delete(result))
  }
  const alertStore =
    memory && (queryCi || queryStars) ? openGitHubAlertStore(memory.databasePath) : undefined
  const webhook =
    alertStore && webhookSecret && webhookRepository
      ? createGitHubWebhookServer({
          secret: webhookSecret,
          repository: webhookRepository,
          receive: (deliveryId, event, receivedAt) =>
            alertStore.receiveWebhook(deliveryId, event, receivedAt),
        })
      : undefined

  channel.on('message', async (message) => {
    if (shutdown.signal.aborted) return
    const startedAt = performance.now()
    const durationMs = () => Math.round(performance.now() - startedAt)
    const log = (event: string, fields: Record<string, string | number | undefined> = {}) => {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: `lark.${event}`,
          messageId: message.messageId,
          ...fields,
        }),
      )
    }

    if (message.chatType === 'group') {
      if (
        !testGroupId &&
        ownerOpenId &&
        message.senderId === ownerOpenId &&
        message.mentionedBot &&
        message.content.trim() === '/group-id'
      ) {
        log('group_discovered', { chatId: message.chatId })
        return
      }
      const turn = groups.route(message)
      if (!turn) return
      log('group_received')

      try {
        await processLarkGroupTurn(turn, {
          signal: shutdown.signal,
          run: groupConversations.run,
          getQuote: (chatId, messageId) => getQuote(chatId, messageId, 'group'),
          previewMerge:
            mergeFlow &&
            ((turn, text, getQuote) =>
              trackMerge(mergeFlow.previewFromGroup(turn, text, getQuote))),
          replyInGroup: async (text) => {
            const destination = turn.threadId
              ? { replyTo: turn.messageId, replyInThread: true }
              : undefined
            const reply = await channel.send(turn.chatId, { text: redact(text) }, destination)
            if (!shutdown.signal.aborted) {
              groups.recordReply(turn, reply.messageId, turn.threadId)
            }
          },
          sendPrivately: async (text) => {
            await channel.send(ownerOpenId, { text: redact(text) })
          },
          reportFailure: (step, error) => {
            const diagnostic =
              error instanceof CodexAnswerError
                ? error.diagnostic
                : { code: error instanceof LarkChannelError ? error.code : 'unknown' }
            log('group_processing_failed', { step, ...diagnostic, durationMs: durationMs() })
          },
        })
        log('group_completed', { durationMs: durationMs() })
      } catch (error) {
        const code = error instanceof LarkChannelError ? error.code : 'unknown'
        log('group_reply_failed', { code, durationMs: durationMs() })
      }
      return
    }

    let stopProgress: ReturnType<typeof startLarkProgress> | undefined
    let source: 'merge' | 'review' | undefined
    let reviewImages: PullRequestReviewReport['images'] = []
    const text = await answerLarkMessage(message, {
      ownerOpenId,
      query,
      run: conversations.run,
      getQuote: getPrivateQuote,
      merge: mergeFlow && ((message, intent) => trackMerge(mergeFlow.answerDm(message, intent))),
      review: async (request) => {
        if (activeReview) return '上一条 PR 评审还在处理，请稍后再试。'
        const job = reviewPullRequest(request)
        activeReview = job
        try {
          const report = await job
          reviewImages = report.images
          return redact(report.text)
        } finally {
          activeReview = undefined
        }
      },
      onUnconfiguredOwner: (openId) => console.log(`Received DM from open_id: ${openId}`),
      onEvent: (entry) => {
        if (entry.event === 'received') {
          source = entry.source
          log(entry.event, source ? { source, action: entry.text } : { text: redact(entry.text) })
          stopProgress = startLarkProgress({
            show: () => channel.addReaction(message.messageId, 'OnIt'),
            hide: (reactionId) => channel.removeReaction(message.messageId, reactionId),
            acknowledge: async () => {
              if (shutdown.signal.aborted) return
              await channel.send(
                message.chatId,
                { text: '收到，正在处理…' },
                { replyTo: message.messageId },
              )
            },
            onError: (operation) => log('progress_failed', { operation }),
          })
          return
        }
        const diagnostic =
          entry.source === 'codex'
            ? entry.error instanceof CodexAnswerError
              ? entry.error.diagnostic
              : { code: 'unexpected_error' }
            : {}
        log(entry.event, { source: entry.source, ...diagnostic, durationMs: durationMs() })
      },
    })
    if (text === undefined) return
    const cleanup = stopProgress?.()
    const reply = source ? { source } : { text: redact(text) }
    try {
      if (shutdown.signal.aborted) {
        log('reply_skipped', { reason: 'shutdown', durationMs: durationMs() })
        return
      }
      await channel.send(message.chatId, { text }, { replyTo: message.messageId })
      log('reply_sent', { ...reply, durationMs: durationMs() })
      const missingImages: string[] = []
      for (const [index, { label, png }] of reviewImages.entries()) {
        if (shutdown.signal.aborted) break
        try {
          await channel.send(ownerOpenId, { image: { source: png } })
        } catch {
          missingImages.push(`图 ${index + 1} · ${label}`)
        }
      }
      if (missingImages.length && !shutdown.signal.aborted) {
        log('review_images_failed', { count: missingImages.length })
        await channel.send(ownerOpenId, {
          text: `这些截图发送失败。请检查 Lark 应用的图片上传权限。\n${missingImages.join('\n')}`,
        })
      }
    } catch (error) {
      const code = error instanceof LarkChannelError ? error.code : 'unknown'
      log('reply_failed', { ...reply, code, durationMs: durationMs() })
    } finally {
      await cleanup
    }
  })
  channel.on('error', () => console.error('Lark could not process an incoming event.'))

  let starting = 'Lark'
  try {
    await channel.connect()
    if (webhook) {
      starting = 'GitHub Webhook'
      await webhook.listen({ host: '127.0.0.1', port: webhookPort })
      console.log(`GitHub Webhook listening on 127.0.0.1:${webhookPort}/webhooks/github.`)
    }
  } catch (error) {
    await Promise.allSettled([channel.disconnect(), webhook?.close()])
    alertStore?.close()
    mergeStore?.close()
    memory?.close()
    const code =
      error instanceof LarkChannelError
        ? error.code
        : error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'unknown'
    throw new Error(`Could not start ${starting} (${code}).`)
  }

  console.log('Connected to Lark via WebSocket.')
  if (!ownerOpenId) {
    console.log(
      'Send the bot a private text message to see your open_id here, then set LARK_OWNER_OPEN_ID and restart.',
    )
  }
  const alertWorker =
    alertStore &&
    runGitHubAlerts({
      store: alertStore,
      recipientOpenId: ownerOpenId,
      queryCi,
      queryChecks: configuredChecksQuery,
      queryInbox,
      queryStars,
      webhookRepository,
      send: createLarkAlertSender(channel.rawClient.im.v1.message, redact),
      signal: shutdown.signal,
      ciIntervalMs: ciPollSeconds * 1_000,
      starIntervalMs: starPollSeconds * 1_000,
      report: (stage, fields) =>
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: `github_alert.${stage}`,
            ...fields,
          }),
        ),
    })
  const stop = () => {
    if (shutdown.signal.aborted) return
    shutdown.abort()
    void Promise.allSettled([
      conversations.close(),
      groupConversations.close(),
      channel.disconnect(),
      webhook?.close(),
      alertWorker,
      activeReview,
      ...pendingMerges,
    ])
      .then((results) => {
        alertStore?.close()
        mergeStore?.close()
        memory?.close()
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('A Lark or Codex component could not close.')
        }
      })
      .catch(() => {
        console.error('Could not close the Lark connection or Codex conversations.')
        process.exitCode = 1
      })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
