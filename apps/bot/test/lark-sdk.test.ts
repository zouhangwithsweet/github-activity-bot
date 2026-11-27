import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type RequestListener } from 'node:http'
import { test, type TestContext } from 'node:test'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { createLarkAlertSender } from '../src/lark-alert-delivery.ts'
import { closeLarkChannel, createLarkSdkOptions } from '../src/lark-sdk.ts'

const tenantTokenPath = '/open-apis/auth/v3/tenant_access_token/internal'

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

await test('SDK token failure logs only allowlisted diagnostic fields', async (t) => {
  const syntheticSecret = 'synthetic-lark-secret-for-log-test'
  const logs: string[] = []
  const domain = await serve(t, (request, response) => {
    assert.equal(request.url, tenantTokenPath)
    request.resume()
    response
      .writeHead(503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ msg: syntheticSecret }))
  })
  const channel = createLarkChannel({
    ...createLarkSdkOptions({ writeError: (line) => logs.push(line) }),
    appId: `cli_${'0'.repeat(15)}1`,
    appSecret: syntheticSecret,
    domain,
    transport: 'webhook',
  })

  try {
    await assert.rejects(channel.connect())
    assert.ok(logs.length > 0)
    assert.ok(logs.every((line) => !line.includes(syntheticSecret) && !line.includes(domain)))
    assert.deepEqual(JSON.parse(logs[0]), {
      event: 'lark.sdk_error',
      stage: 'tenant_token',
      code: 'ERR_BAD_RESPONSE',
      status: 503,
    })
  } finally {
    await closeLarkChannel(channel)
  }
})

await test(
  'a timed-out SDK send aborts the HTTP request and allows the next alert to send',
  { timeout: 2_000 },
  async (t) => {
    const firstClosed = Promise.withResolvers<void>()
    let deliveries = 0
    const domain = await serve(t, (request, response) => {
      request.resume()
      if (request.url === tenantTokenPath) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ code: 0, tenant_access_token: 'synthetic-token', expire: 7_200 }))
        return
      }
      assert.ok(request.url?.startsWith('/open-apis/im/v1/messages?'))
      deliveries++
      if (deliveries === 1) {
        response.once('close', () => firstClosed.resolve())
        return
      }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ code: 0, data: { message_id: 'synthetic-message' } }))
    })
    const channel = createLarkChannel({
      ...createLarkSdkOptions({ timeoutMs: 200, writeError: () => {} }),
      appId: `cli_${'0'.repeat(15)}2`,
      appSecret: 'unused-test-secret',
      domain,
      transport: 'webhook',
    })
    const send = createLarkAlertSender(channel.rawClient.im.v1.message, (text) => text)
    const alert = { id: 'first', recipientOpenId: 'synthetic-recipient', text: 'test' }

    try {
      assert.deepEqual(await send(alert), { kind: 'unknown', reason: 'delivery_unconfirmed' })
      assert.equal(deliveries, 1)
      await firstClosed.promise
      assert.deepEqual(await send({ ...alert, id: 'second' }), { kind: 'sent' })
      assert.equal(deliveries, 2)
    } finally {
      await closeLarkChannel(channel)
    }
  },
)

await test(
  'failed WebSocket startup closes the SDK client before it connects',
  { timeout: 2_000 },
  async (t) => {
    const domain = await serve(t, (request, response) => {
      request.resume()
      response.setHeader('content-type', 'application/json')
      switch (request.url) {
        case tenantTokenPath:
          response.end(
            JSON.stringify({ code: 0, tenant_access_token: 'synthetic-token', expire: 7_200 }),
          )
          break
        case '/open-apis/bot/v3/info':
          response.end(JSON.stringify({ code: 0, bot: { open_id: 'synthetic-bot' } }))
          break
        case '/callback/ws/endpoint':
          response.end(
            JSON.stringify({ code: 400001, data: {}, msg: 'fixture rejects connection' }),
          )
          break
        default:
          response.writeHead(404).end()
      }
    })
    const channel = createLarkChannel({
      ...createLarkSdkOptions({ timeoutMs: 500, writeError: () => {} }),
      appId: `cli_${'0'.repeat(15)}3`,
      appSecret: 'unused-test-secret',
      domain,
    })
    t.after(() => closeLarkChannel(channel))

    await assert.rejects(channel.connect(), { code: 'not_connected' })
    assert.ok(channel.rawWsClient)
    assert.equal(channel.getConnectionStatus()?.state, 'failed')
    const close = t.mock.method(channel.rawWsClient, 'close')
    await channel.disconnect()
    assert.equal(close.mock.callCount(), 0)
    await closeLarkChannel(channel)
    assert.deepEqual(
      close.mock.calls.map(({ arguments: args }) => args),
      [[{ force: true }]],
    )
  },
)
