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
  const question = { ...message, content: '我有哪些 PR 卡在 CI？' }
  const options = {
    ownerOpenId: 'ou_owner',
    query: async () => assert.fail('Unexpected GitHub query'),
    answer: async () => assert.fail('Unexpected Codex call'),
    onUnconfiguredOwner: (openId: string) => discovered.push(openId),
  }
  assert.equal(await answerLarkMessage(question, { ...options, ownerOpenId: '' }), undefined)
  assert.equal(await answerLarkMessage({ ...question, senderId: 'ou_other' }, options), undefined)
  assert.equal(await answerLarkMessage({ ...question, chatType: 'group' }, options), undefined)
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
      unavailableRepositories: ['example/private-repo'],
      pullRequests: [failing, { ...failing, number: 43, checks: null }],
    }),
    answer: async () => assert.fail('Fixed commands should bypass Codex'),
    onUnconfiguredOwner: () => assert.fail('Unexpected discovery mode'),
  })
  assert.match(reply ?? '', /1 个检查失败的开放 PR/)
  assert.match(reply ?? '', /结果不完整。无法读取 example\/private-repo 的 PR/)
  assert.match(reply ?? '', /example\/bot\/pull\/42/)
  assert.doesNotMatch(reply ?? '', /#43/)
})

await test('routes authorized natural language to Codex and keeps unknown slash commands local', async () => {
  const questions: string[] = []
  const question = '我有哪些 PR 卡在 CI？'
  const options = {
    ownerOpenId: 'ou_owner',
    query: async () => assert.fail('Unexpected direct GitHub query'),
    answer: async (text: string) => {
      questions.push(text)
      return '目前没有 PR 卡在 CI。'
    },
    onUnconfiguredOwner: () => assert.fail('Unexpected discovery mode'),
  }
  assert.equal(
    await answerLarkMessage({ ...message, content: question }, options),
    '目前没有 PR 卡在 CI。',
  )
  assert.match((await answerLarkMessage({ ...message, content: '/help' }, options)) ?? '', /\/prs/)
  assert.deepEqual(questions, [question])
})
