import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLarkChannel, Domain, LarkChannelError } from '@larksuiteoapi/node-sdk'
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
  larkSessionStatus,
  openRememberedConversation,
  parseLarkSessionCommand,
  startLarkProgress,
  type LarkSessionCommand,
  type LarkSessionEvent,
} from './lark-handler.ts'
import { openLarkMemory } from './lark-memory.ts'
import { createLarkMergeFlow } from './lark-merge.ts'
import { openLarkMergeStore } from './lark-merge-store.ts'
import { normalizeLarkQuote, type GetLarkQuote } from './lark-quote.ts'
import { closeLarkChannel, createLarkSdkOptions } from './lark-sdk.ts'
import { createPullRequestReview, type PullRequestReviewReport } from './pull-request-review.ts'

class BotStartupError extends Error {
  readonly stage: 'configuration' | 'lark' | 'webhook'
  readonly code: string

  constructor(stage: BotStartupError['stage'], code: string, message: string) {
    super(message)
    this.stage = stage
    this.code = code
  }
}

const configurationError = (message: string) =>
  new BotStartupError('configuration', 'invalid_configuration', message)

const webhookStartupCodes = new Set(['EADDRINUSE', 'EACCES', 'EPERM', 'EADDRNOTAVAIL'])

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
  const starWebhookSetting = process.env.GH_STAR_WEBHOOK?.trim() || undefined
  const starWebhookEnabled =
    starWebhookSetting === '1' || (!starsEnabled && starWebhookSetting !== '0')
  const webhookSecret = process.env.GH_WEBHOOK_SECRET?.trim()
  const webhookRepository = process.env.GH_WEBHOOK_REPOSITORY?.trim()
  const webhookPort = Number(process.env.GH_WEBHOOK_PORT?.trim() || 8787)
  const configuredQuery = createPullRequestQuery()
  const configuredDetailQuery = createPullRequestDetailQuery()
  const configuredChecksQuery = createPullRequestChecksQuery()
  const configuredReviewsQuery = createPullRequestReviewsQuery()
  const merger = createPullRequestMerger()

  if (!appId || !appSecret)
    throw configurationError('Set LARK_APP_ID and LARK_APP_SECRET in the local environment.')
  if (ownerOpenId && !ownerOpenId.startsWith('ou_')) {
    throw configurationError('LARK_OWNER_OPEN_ID must be the open_id for this Lark app.')
  }
  if (testGroupId && (!testGroupId.startsWith('oc_') || !ownerOpenId)) {
    throw configurationError(
      'Set LARK_TEST_GROUP_CHAT_ID to a group chat_id and set LARK_OWNER_OPEN_ID.',
    )
  }
  if ((alertsEnabled || starsEnabled) && !ownerOpenId) {
    throw configurationError('Set LARK_OWNER_OPEN_ID to enable GitHub alerts.')
  }
  if (
    starRepoSource !== undefined &&
    starRepoSource !== 'watched' &&
    starRepoSource !== 'accessible'
  ) {
    throw configurationError('GH_STAR_REPO_SOURCE must be watched or accessible.')
  }
  if (starRepositories.some((repository) => !isRepositoryName(repository))) {
    throw configurationError('GH_STAR_REPOSITORIES must contain comma-separated owner/repo names.')
  }
  if (
    starsEnabled &&
    (!Number.isInteger(starPollSeconds) || starPollSeconds < 60 || starPollSeconds > 86400)
  ) {
    throw configurationError('GH_STAR_POLL_SECONDS must be a whole number between 60 and 86400.')
  }
  if (
    starWebhookSetting !== undefined &&
    starWebhookSetting !== '0' &&
    starWebhookSetting !== '1'
  ) {
    throw configurationError('GH_STAR_WEBHOOK must be 0 or 1.')
  }
  if (webhookSecret || webhookRepository) {
    if (
      !alertsEnabled ||
      !webhookSecret ||
      !webhookRepository ||
      !isRepositoryName(webhookRepository)
    ) {
      throw configurationError(
        'GitHub Webhooks require LARK_GITHUB_ALERTS=1, GH_WEBHOOK_SECRET, and GH_WEBHOOK_REPOSITORY as owner/repo.',
      )
    }
    if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
      throw configurationError('GH_WEBHOOK_PORT must be a whole TCP port between 1 and 65535.')
    }
  }
  if (
    alertsEnabled &&
    (!Number.isInteger(ciPollSeconds) || ciPollSeconds < 30 || ciPollSeconds > 86400)
  ) {
    throw configurationError(
      'GH_ACTIVITY_POLL_SECONDS must be a whole number between 30 and 86400.',
    )
  }
  if (
    ownerOpenId &&
    (!configuredQuery ||
      !configuredDetailQuery ||
      !configuredChecksQuery ||
      !configuredReviewsQuery)
  ) {
    throw configurationError('Set GH_TOKEN or GH_ORG_TOKEN to enable PR queries.')
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
  let activeReview: Promise<void> | undefined
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
    throw configurationError('Set GH_TOKEN or GH_ORG_TOKEN to enable Star polling.')
  }
  const memory = ownerOpenId ? openLarkMemory(stateDir, { appId, ownerOpenId }) : undefined
  const logSession = (
    scope: string,
    { action, ...fields }: LarkSessionEvent | { action: 'reset_requested' | 'command_failed' },
  ) => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: `lark.session_${action}`,
        kind: scope.startsWith('dm:') ? 'dm' : 'group',
        scope: createHash('sha256').update(scope).digest('hex').slice(0, 12),
        ...fields,
      }),
    )
  }
  const openSession = (tools: GitHubConversationTools, name: string, resume?: string) =>
    openGitHubConversation(tools, shutdown.signal, memory && { cwd: memory.cwd, resume }, name)
  const conversations = createLarkConversations((chatId) => {
    const scope = `dm:${chatId}`
    return openRememberedConversation(
      scope,
      memory,
      (resume) => openSession(github, 'GitHub Bot · 私聊', resume),
      (event) => logSession(scope, event),
    )
  })
  const groups = createLarkGroupRouter({
    ownerOpenId,
    allowedChatIds: testGroupId ? [testGroupId] : [],
    memory,
  })
  const publicRepository = createPublicRepositoryQuery()
  const groupConversations = createLarkConversations(async (scope) => {
    return openRememberedConversation(
      scope,
      memory,
      async (resume) => {
        const access = trackGroupGitHubAccess(github, publicRepository, memory && { scope, memory })
        const conversation = await openSession(access.tools, 'GitHub Bot · 群话题', resume)
        try {
          access.bindSession(conversation.id)
        } catch (error) {
          await conversation.close().catch(() => undefined)
          throw error
        }
        return {
          id: conversation.id,
          answer: async (question: string) => {
            const text = await conversation.answer(question)
            return { text, canReplyInGroup: await access.canReplyInGroup() }
          },
          close: conversation.close,
        }
      },
      (event) => logSession(scope, event),
    )
  }, 30 * 60_000)
  const manageSession = async (
    command: LarkSessionCommand,
    scope: string,
    reset: (requestReset: () => boolean) => Promise<boolean>,
  ) => {
    if (!memory) return '会话记忆尚未启用。'
    try {
      if (command === 'status') return larkSessionStatus(memory, scope)
      if (!(await reset(() => memory.requestSessionReset(scope)))) {
        return '当前聊天还没有可重置的 Codex 会话。'
      }
      logSession(scope, { action: 'reset_requested' })
      return '当前会话已重置。历史仍可在 Codex 里查看，下次问答时会开启新会话。'
    } catch {
      logSession(scope, { action: 'command_failed' })
      return '暂时无法完成会话操作，请稍后重试。'
    }
  }

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
    ...createLarkSdkOptions({ signal: shutdown.signal }),
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
        const replyInGroup = async (text: string) => {
          const destination = turn.threadId
            ? { replyTo: turn.messageId, replyInThread: true }
            : undefined
          const reply = await channel.send(turn.chatId, { text: redact(text) }, destination)
          if (!shutdown.signal.aborted) {
            groups.recordReply(turn, reply.messageId, turn.threadId)
          }
        }
        const sessionCommand = parseLarkSessionCommand(turn.question)
        if (sessionCommand) {
          const text = await manageSession(sessionCommand, turn.sessionKey, (requestReset) =>
            groupConversations.reset(turn.sessionKey, requestReset),
          )
          if (!shutdown.signal.aborted) await replyInGroup(text)
          return
        }
        await processLarkGroupTurn(turn, {
          signal: shutdown.signal,
          run: groupConversations.run,
          getQuote: (chatId, messageId) => getQuote(chatId, messageId, 'group'),
          previewMerge:
            mergeFlow &&
            ((turn, text, getQuote) =>
              trackMerge(mergeFlow.previewFromGroup(turn, text, getQuote))),
          replyInGroup,
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
    let reviewCompletion: PromiseWithResolvers<void> | undefined
    let cleanup: Promise<void> | undefined
    let reply: Record<string, string> = {}
    try {
      const text = await answerLarkMessage(message, {
        ownerOpenId,
        query,
        run: conversations.run,
        sessionCommand: (command, chatId) =>
          manageSession(command, `dm:${chatId}`, (requestReset) =>
            conversations.reset(chatId, requestReset),
          ),
        getQuote: getPrivateQuote,
        merge: mergeFlow && ((message, intent) => trackMerge(mergeFlow.answerDm(message, intent))),
        review: async (request) => {
          if (activeReview) return '上一条 PR 评审还在处理，请稍后再试。'
          reviewCompletion = Promise.withResolvers<void>()
          activeReview = reviewCompletion.promise
          const report = await reviewPullRequest(request)
          reviewImages = report.images
          return report.text
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
      cleanup = stopProgress?.()
      const safeText = redact(text)
      reply = source ? { source } : { text: safeText }
      if (shutdown.signal.aborted) {
        log('reply_skipped', { reason: 'shutdown', durationMs: durationMs() })
        return
      }
      const summary = await channel.send(
        message.chatId,
        { text: safeText },
        { replyTo: message.messageId },
      )
      log('reply_sent', { ...reply, durationMs: durationMs() })
      const missingImages: string[] = []
      for (const [index, { label, png }] of reviewImages.entries()) {
        if (shutdown.signal.aborted) break
        try {
          await channel.send(
            message.chatId,
            { image: { source: png } },
            { replyTo: summary.messageId },
          )
        } catch {
          missingImages.push(`图 ${index + 1} · ${label}`)
        }
      }
      if (missingImages.length && !shutdown.signal.aborted) {
        log('review_images_failed', { count: missingImages.length })
        await channel.send(
          message.chatId,
          { text: `这些截图发送失败。可以重新发起评审。\n${missingImages.join('\n')}` },
          { replyTo: summary.messageId },
        )
      }
    } catch (error) {
      const code = error instanceof LarkChannelError ? error.code : 'unknown'
      log('reply_failed', { ...reply, code, durationMs: durationMs() })
    } finally {
      if (reviewCompletion) {
        activeReview = undefined
        reviewCompletion.resolve()
      }
      await (cleanup ?? stopProgress?.())
    }
  })
  channel.on('error', () => console.error('Lark could not process an incoming event.'))

  let starting: 'lark' | 'webhook' = 'lark'
  try {
    await channel.connect()
    if (webhook) {
      starting = 'webhook'
      await webhook.listen({ host: '127.0.0.1', port: webhookPort })
      console.log(`GitHub Webhook listening on 127.0.0.1:${webhookPort}/webhooks/github.`)
    }
  } catch (error) {
    shutdown.abort()
    await Promise.allSettled([
      closeLarkChannel(channel),
      conversations.close(),
      groupConversations.close(),
      webhook?.close(),
      activeReview,
      ...pendingMerges,
    ])
    alertStore?.close()
    mergeStore?.close()
    memory?.close()
    let code = 'unknown'
    if (starting === 'lark' && error instanceof LarkChannelError) code = error.code
    if (
      starting === 'webhook' &&
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      webhookStartupCodes.has(error.code)
    ) {
      code = error.code
    }
    const component = starting === 'lark' ? 'Lark' : 'GitHub Webhook'
    throw new BotStartupError(starting, code, `Could not start ${component} (${code}).`)
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
      starWebhookEnabled,
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
      closeLarkChannel(channel),
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
  const diagnostic = error instanceof BotStartupError ? error : undefined
  console.log(
    `github-activity-bot startup_failed ${diagnostic?.stage ?? 'bot'} ${diagnostic?.code ?? 'unknown'}`,
  )
  console.error(diagnostic?.message ?? 'GitHub Activity Bot could not start.')
  process.exitCode = 1
}
