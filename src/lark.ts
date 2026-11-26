import { createLarkChannel, Domain, LarkChannelError, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { answerGitHubQuestion, CodexAnswerError } from './agent.ts'
import { createPullRequestQuery } from './github.ts'
import { answerLarkMessage } from './lark-handler.ts'

async function main() {
  const appId = process.env.LARK_APP_ID?.trim()
  const appSecret = process.env.LARK_APP_SECRET?.trim()
  const ownerOpenId = process.env.LARK_OWNER_OPEN_ID?.trim() ?? ''
  const configuredQuery = createPullRequestQuery()

  if (!appId || !appSecret)
    throw new Error('Set LARK_APP_ID and LARK_APP_SECRET in the local environment.')
  if (ownerOpenId && !ownerOpenId.startsWith('ou_')) {
    throw new Error('LARK_OWNER_OPEN_ID must be the open_id for this Lark app.')
  }
  if (ownerOpenId && !configuredQuery)
    throw new Error('Set GH_TOKEN or GH_ORG_TOKEN to enable PR queries.')

  const shutdown = new AbortController()
  const query = configuredQuery ?? (() => Promise.reject(new Error('GitHub token is missing.')))

  const secrets = [
    appSecret,
    process.env.GH_TOKEN?.trim(),
    process.env.GITHUB_TOKEN?.trim(),
    process.env.GH_ORG_TOKEN?.trim(),
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
    policy: ownerOpenId ? { dmMode: 'allowlist', dmAllowlist: [ownerOpenId] } : { dmMode: 'open' },
    safety: { batch: { text: { delayMs: 0, maxMessages: 1 } } },
  })

  channel.on('message', async (message) => {
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

    const text = await answerLarkMessage(message, {
      ownerOpenId,
      query,
      answer: (question) => answerGitHubQuestion(question, query, shutdown.signal),
      onUnconfiguredOwner: (openId) => console.log(`Received DM from open_id: ${openId}`),
      onEvent: (entry) => {
        if (entry.event === 'received') {
          log(entry.event, { text: redact(entry.text) })
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
    if (shutdown.signal.aborted) {
      log('reply_skipped', { reason: 'shutdown', durationMs: durationMs() })
      return
    }

    const reply = redact(text)
    try {
      await channel.send(message.chatId, { text }, { replyTo: message.messageId })
      log('reply_sent', { text: reply, durationMs: durationMs() })
    } catch (error) {
      const code = error instanceof LarkChannelError ? error.code : 'unknown'
      log('reply_failed', { text: reply, code, durationMs: durationMs() })
    }
  })
  channel.on('error', () => console.error('Lark could not process an incoming event.'))

  try {
    await channel.connect()
  } catch (error) {
    await channel.disconnect()
    const code = error instanceof LarkChannelError ? error.code : 'unknown'
    throw new Error(`Could not connect to Lark (${code}). Check app credentials and connectivity.`)
  }

  console.log('Connected to Lark via WebSocket.')
  if (!ownerOpenId) {
    console.log(
      'Send the bot a private text message to see your open_id here, then set LARK_OWNER_OPEN_ID and restart.',
    )
  }
  const stop = () => {
    shutdown.abort()
    void channel.disconnect().catch(() => {
      console.error('Could not close the Lark connection.')
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
