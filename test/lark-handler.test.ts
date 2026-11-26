import assert from 'node:assert/strict'
import test from 'node:test'
import { answerLarkMessage } from '../src/lark-handler.ts'

const message = {
  chatType: 'p2p',
  senderId: 'ou_owner',
  rawContentType: 'text',
  content: 'CI 失败',
} as const

await test('owner discovery and other chats cannot trigger a GitHub query', async () => {
  const discovered: string[] = []
  const options = {
    ownerOpenId: 'ou_owner',
    query: async () => assert.fail('Unexpected GitHub query'),
    onUnconfiguredOwner: (openId: string) => discovered.push(openId),
  }
  assert.equal(await answerLarkMessage(message, { ...options, ownerOpenId: '' }), undefined)
  assert.equal(await answerLarkMessage({ ...message, senderId: 'ou_other' }, options), undefined)
  assert.equal(await answerLarkMessage({ ...message, chatType: 'group' }, options), undefined)
  assert.deepEqual(discovered, ['ou_owner'])
})

await test('returns only failed checks and PR links for an authorized private message', async () => {
  const failing = {
    number: 42,
    title: 'Fix build',
    url: 'https://github.com/example/bot/pull/42',
    draft: false,
    repository: 'example/bot',
    checks: 'FAILURE',
  } as const
  const reply = await answerLarkMessage(message, {
    ownerOpenId: 'ou_owner',
    query: async () => ({
      login: 'demo',
      pullRequests: [failing, { ...failing, number: 43, checks: null }],
    }),
    onUnconfiguredOwner: () => assert.fail('Unexpected discovery mode'),
  })
  assert.match(reply ?? '', /1 个检查失败的开放 PR/)
  assert.match(reply ?? '', /example\/bot\/pull\/42/)
  assert.doesNotMatch(reply ?? '', /#43/)
})
