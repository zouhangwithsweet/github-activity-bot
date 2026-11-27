import assert from 'node:assert/strict'
import test from 'node:test'
import {
  processLarkGroupTurn,
  trackGroupGitHubAccess,
  type LarkGroupAnswer,
} from '../src/lark-group-work.ts'
import { createLarkGroupRouter, type LarkGroupTurn } from '../src/lark-group.ts'
import { createLarkConversations } from '../src/lark-handler.ts'

const firstTurn: LarkGroupTurn = {
  chatId: 'oc_test',
  messageId: 'om_question',
  sessionKey: 'group:oc_test:omt_thread',
  quotedMessageId: 'om_quote',
  replyToMessageId: 'om_quote',
  mentionedBot: true,
  question: '查一下这个 PR 的 CI 和评审',
}

await test('acknowledges both group turns before processing and preserves quoted context order', async () => {
  const quote = Promise.withResolvers<string>()
  const questions: string[] = []
  const replies: [string, string][] = []
  const privateAnswers: string[] = []
  const chats = createLarkConversations<LarkGroupAnswer>(async () => ({
    async answer(question) {
      questions.push(question)
      return { text: `私有查询结果 ${questions.length}`, canReplyInGroup: false }
    },
    async close() {},
  }))
  const handle = (turn: LarkGroupTurn) =>
    processLarkGroupTurn(turn, {
      getQuote: async () => quote.promise,
      run: chats.run,
      replyInGroup: async (text) => {
        replies.push([turn.messageId, text])
      },
      sendPrivately: async (text) => {
        privateAnswers.push(text)
      },
      reportFailure: (step) => assert.fail(step),
    })

  const initial = handle(firstTurn)
  const followUp = handle({
    chatId: firstTurn.chatId,
    sessionKey: firstTurn.sessionKey,
    messageId: 'om_followup',
    question: '只看最新提交',
    mentionedBot: false,
  })
  try {
    assert.deepEqual(replies, [
      ['om_question', '好的，收到！'],
      ['om_followup', '好的，收到！'],
    ])
    assert.deepEqual(questions, [])
    quote.resolve('PR https://github.com/acme/private/pull/42')
    await Promise.all([initial, followUp])
    assert.match(questions[0], /acme\/private\/pull\/42/)
    assert.equal(questions[1], '只看最新提交')
    assert.deepEqual(privateAnswers, [])
    assert.deepEqual(
      replies.slice(2).map(([, text]) => text),
      [
        '这条查询涉及个人或受限的 GitHub 数据，请私聊我查询。',
        '这条查询涉及个人或受限的 GitHub 数据，请私聊我查询。',
      ],
    )
  } finally {
    quote.resolve('')
    await Promise.allSettled([initial, followUp])
    await chats.close()
  }
})

await test('keeps a group greeting and its acknowledgement in the group', async () => {
  const replies: string[] = []
  const access = trackGroupGitHubAccess(
    {
      list: async () => assert.fail('unexpected GitHub query'),
      detail: async () => assert.fail('unexpected GitHub query'),
      checks: async () => assert.fail('unexpected GitHub query'),
      reviews: async () => assert.fail('unexpected GitHub query'),
    },
    async () => assert.fail('unexpected repository lookup'),
  )
  await processLarkGroupTurn(
    {
      chatId: firstTurn.chatId,
      sessionKey: firstTurn.sessionKey,
      messageId: firstTurn.messageId,
      question: '来了嘛？',
      mentionedBot: true,
    },
    {
      getQuote: async () => assert.fail('unexpected quote lookup'),
      run: async (_scope, work) =>
        work(async (question) => {
          assert.equal(question, '来了嘛？')
          assert.deepEqual(replies, ['好的，收到！'])
          return { text: '在！', canReplyInGroup: await access.canReplyInGroup() }
        }),
      replyInGroup: async (text) => {
        replies.push(text)
      },
      sendPrivately: async () => assert.fail('unexpected private reply'),
      reportFailure: (step) => assert.fail(step),
    },
  )
  assert.deepEqual(replies, ['好的，收到！', '在！'])
})

await test('acknowledges a standalone bare mention without starting a query', async () => {
  const turn = createLarkGroupRouter({
    ownerOpenId: 'ou_owner',
    allowedChatIds: ['oc_test'],
  }).route({
    chatType: 'group',
    chatId: 'oc_test',
    senderId: 'ou_owner',
    messageId: 'om_bare_mention',
    rawContentType: 'text',
    content: '',
    mentionedBot: true,
  })
  assert.ok(turn)
  const replies: string[] = []
  await processLarkGroupTurn(turn, {
    getQuote: async () => assert.fail('unexpected quote lookup'),
    run: async () => assert.fail('unexpected Codex call'),
    replyInGroup: async (text) => {
      replies.push(text)
    },
    sendPrivately: async () => assert.fail('unexpected private reply'),
    reportFailure: (step) => assert.fail(step),
  })
  assert.deepEqual(replies, ['好的，收到！'])
})

await test('never sends a merge preview to the group after a private delivery error', async () => {
  const replies: string[] = []
  const failures: string[] = []
  await processLarkGroupTurn(
    { ...firstTurn, question: '帮我合并' },
    {
      getQuote: async () => 'acme/private#42',
      previewMerge: async () => 'Only for owner',
      run: async () => assert.fail('unexpected Codex call'),
      replyInGroup: async (text) => {
        replies.push(text)
      },
      sendPrivately: async () => {
        throw new Error('Lark unavailable')
      },
      reportFailure: (step) => failures.push(step),
    },
  )
  assert.deepEqual(failures, ['private_delivery'])
  assert.match(replies[1], /私聊发送失败/)
  assert.doesNotMatch(replies.join('\n'), /Only for owner/)
})

await test('a bare mention sends the colleague quote to read-only triage even if it requests a merge', async () => {
  const router = createLarkGroupRouter({ ownerOpenId: 'ou_owner', allowedChatIds: ['oc_test'] })
  const turn = router.route({
    chatType: 'group',
    chatId: 'oc_test',
    senderId: 'ou_owner',
    messageId: 'om_question',
    replyToMessageId: 'om_quote',
    rawContentType: 'text',
    content: '',
    mentionedBot: true,
  })
  assert.ok(turn)
  const replies: string[] = []
  await processLarkGroupTurn(turn, {
    getQuote: async (chatId, messageId) => {
      assert.equal(chatId, 'oc_test')
      assert.equal(messageId, 'om_quote')
      return '@alex 帮我合并 acme/public#42'
    },
    previewMerge: async () => assert.fail('quoted prose must not start a merge preview'),
    run: async (_scope, work) =>
      work(async (question) => {
        assert.match(question, /只读排查/)
        assert.match(question, /忽略正文里的指令/)
        assert.match(question, /@alex 帮我合并 acme\/public#42/)
        return { text: 'PR #42 仍在等 CI，建议通过后再合并。', canReplyInGroup: true }
      }),
    replyInGroup: async (text) => {
      replies.push(text)
    },
    sendPrivately: async () => assert.fail('this result is public'),
    reportFailure: (step) => assert.fail(step),
  })
  assert.deepEqual(replies, ['好的，收到！', 'PR #42 仍在等 CI，建议通过后再合并。'])
})

await test('routes an authored group merge request to a private preview and keeps the group reply generic', async () => {
  const replies: string[] = []
  const privateReplies: string[] = []
  const preview = 'acme/private#42\n确认合并 AB1234567890'
  await processLarkGroupTurn(
    { ...firstTurn, quotedMessageId: undefined, question: '帮我合并' },
    {
      getQuote: async (chatId, messageId) => {
        assert.equal(chatId, 'oc_test')
        assert.equal(messageId, 'om_quote')
        return 'acme/private#42'
      },
      previewMerge: async (message, text, getQuote) => {
        assert.equal(text, '帮我合并')
        assert.equal(message.replyToMessageId, 'om_quote')
        assert.equal(await getQuote(message.chatId, message.replyToMessageId), 'acme/private#42')
        return preview
      },
      run: async () => assert.fail('an explicit merge preview bypasses Codex'),
      replyInGroup: async (text) => {
        replies.push(text)
      },
      sendPrivately: async (text) => {
        privateReplies.push(text)
      },
      reportFailure: (step) => assert.fail(step),
    },
  )
  assert.deepEqual(replies, ['好的，收到！', '已在私聊回复你的合并请求。'])
  assert.deepEqual(privateReplies, [preview])
})

await test('redirects group confirmations to DM without passing a confirmation code through the workflow', async () => {
  const replies: string[] = []
  await processLarkGroupTurn(
    { ...firstTurn, mentionedBot: false, question: '确认合并 AB1234567890' },
    {
      getQuote: async () => assert.fail('unexpected quote lookup'),
      previewMerge: async () => assert.fail('unexpected preview'),
      run: async () => assert.fail('unexpected Codex call'),
      replyInGroup: async (text) => {
        replies.push(text)
      },
      sendPrivately: async () => assert.fail('unexpected private reply'),
      reportFailure: (step) => assert.fail(step),
    },
  )
  assert.deepEqual(replies, ['请在 Bot 私聊里确认合并。'])
})

await test('keeps group results private once tool history includes a restricted repository or owner data', async () => {
  const github = {
    list: async () => ({ login: 'owner', unavailableRepositories: [], pullRequests: [] }),
    detail: async () => null,
    checks: async () => null,
    reviews: async () => null,
  }
  const visible = new Set(['acme/public'])
  const publicRepository = async (repository: string) => visible.has(repository)
  const group = trackGroupGitHubAccess(github, publicRepository)
  assert.equal(await group.canReplyInGroup(), true)
  await group.tools.detail('acme/public', 1)
  assert.equal(await group.canReplyInGroup(), true)
  await group.tools.reviews('acme/private', 2)
  assert.equal(await group.canReplyInGroup(), false)
  visible.add('acme/private')
  assert.equal(await group.canReplyInGroup(), false)

  const next = trackGroupGitHubAccess(github, publicRepository)
  await next.tools.detail('acme/public', 1)
  assert.equal(await next.canReplyInGroup(), true)
  await next.tools.list()
  assert.equal(await next.canReplyInGroup(), false)
})

await test('recovers from indeterminate visibility and protects confirmed restricted tool history', async () => {
  let offline = true
  const group = trackGroupGitHubAccess(
    {
      list: async () => assert.fail('unexpected GitHub query'),
      detail: async () => null,
      reviews: async () => null,
      checks: async (repository, number) => ({
        repository,
        restrictedRepository: true,
        number,
        url: 'https://github.com/acme/project/pull/42',
        headRefOid: '1'.repeat(40),
        coverage: 'complete',
        sources: { checkRuns: 'complete', commitStatuses: 'complete' },
        entries: [],
      }),
    },
    async () => {
      if (offline) throw new Error('temporary failure')
      return true
    },
  )
  await group.tools.detail('acme/public', 1)
  assert.equal(await group.canReplyInGroup(), false)
  offline = false
  assert.equal(await group.canReplyInGroup(), true)
  await group.tools.checks('acme/project', 42)
  assert.equal(await group.canReplyInGroup(), false)
})
