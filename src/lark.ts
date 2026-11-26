import { createLarkChannel, Domain, LarkChannelError, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { listOpenPullRequests } from './github.ts'
import { answerLarkMessage } from './lark-handler.ts'

async function main() {
  const appId = process.env.LARK_APP_ID?.trim()
  const appSecret = process.env.LARK_APP_SECRET?.trim()
  const ownerOpenId = process.env.LARK_OWNER_OPEN_ID?.trim() ?? ''
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()

  if (!appId || !appSecret)
    throw new Error('Set LARK_APP_ID and LARK_APP_SECRET in the local environment.')
  if (ownerOpenId && !ownerOpenId.startsWith('ou_')) {
    throw new Error('LARK_OWNER_OPEN_ID must be the open_id for this Lark app.')
  }
  if (ownerOpenId && !token) throw new Error('Set GH_TOKEN or GITHUB_TOKEN to enable PR queries.')

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
    const text = await answerLarkMessage(message, {
      ownerOpenId,
      query: () => listOpenPullRequests(token ?? ''),
      onUnconfiguredOwner: (openId) => console.log(`Received DM from open_id: ${openId}`),
    })
    if (text === undefined) return

    try {
      await channel.send(message.chatId, { text }, { replyTo: message.messageId })
    } catch (error) {
      const code = error instanceof LarkChannelError ? error.code : 'unknown'
      console.error(`Lark reply failed (${code}).`)
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
