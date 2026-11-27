import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { normalize, type NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { createPullRequestMerger } from '../src/github-merge.ts'
import type { PullRequestDetail } from '../src/github.ts'
import { answerLarkMessage } from '../src/lark-handler.ts'
import { openLarkMergeStore } from '../src/lark-merge-store.ts'
import { createLarkMergeFlow } from '../src/lark-merge.ts'
import { normalizeLarkQuote, type GetLarkQuote } from '../src/lark-quote.ts'

const ownerOpenId = 'ou_owner'
const chatId = 'oc_owner'
const repository = 'Example/Project'
const headRefOid = 'a'.repeat(40)
const mergeCommit = 'c'.repeat(40)
const url = 'https://github.com/Example/Project/pull/42'
const botIdentity = { openId: 'ou_bot', name: 'GitHub Activity Bot' }
const config = {
  GH_MERGE_TOKEN: 'test-only-credential',
  GH_MERGE_REPOSITORIES: repository,
}

function fakePR(): PullRequestDetail {
  return {
    repository,
    number: 42,
    title: 'Fix console rendering',
    url,
    body: '',
    bodyTruncated: false,
    state: 'OPEN',
    draft: false,
    baseRefName: 'main',
    headRefName: 'fix-console',
    headRefOid,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    checks: 'SUCCESS',
    changedFiles: 1,
    additions: 4,
    deletions: 2,
  }
}

async function larkMessage(text: string, parentId?: string) {
  return normalize(
    {
      sender: { sender_id: { open_id: ownerOpenId } },
      message: {
        message_id: 'om_note',
        chat_id: chatId,
        chat_type: 'p2p',
        message_type: 'post',
        parent_id: parentId,
        mentions: [
          { key: '@_user_1', name: botIdentity.name, id: { open_id: botIdentity.openId } },
        ],
        content: JSON.stringify({
          content: [
            [
              { tag: 'text', text },
              { tag: 'at', user_id: botIdentity.openId },
            ],
          ],
        }),
      },
    },
    { botIdentity },
  )
}

const success = () => Response.json({ merged: true, sha: mergeCommit })

function fixture(
  t: TestContext,
  {
    env = config,
    request = async () => success(),
    getQuote = async () => undefined,
  }: {
    env?: NodeJS.ProcessEnv
    request?: typeof fetch
    getQuote?: GetLarkQuote
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'lark-merge-flow-'))
  const memoryPath = join(directory, 'memory.sqlite')
  let store = openLarkMergeStore(memoryPath)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  let now = 400
  const pr = fakePR()
  const reads: [string, number][] = []
  const writes: { url: string; body: unknown }[] = []
  const merger = createPullRequestMerger(env, async (input, init) => {
    assert.equal(typeof input, 'string')
    assert.equal(typeof init?.body, 'string')
    writes.push({ url: input as string, body: JSON.parse(init?.body as string) as unknown })
    return request(input, init)
  })

  function mergeFlow(owner: string) {
    return createLarkMergeFlow({
      ownerOpenId: owner,
      detail: async (repository, number) => {
        reads.push([repository, number])
        return { ...pr }
      },
      merger,
      store,
      getQuote,
      signal: new AbortController().signal,
      now: () => now,
    })
  }

  function handle(message: NormalizedMessage, owner = ownerOpenId) {
    return answerLarkMessage(message, {
      ownerOpenId: owner,
      query: async () => assert.fail('Unexpected PR list query'),
      run: (_chat, work) => work(async () => 'Codex read-only entry point'),
      getQuote,
      onUnconfiguredOwner: () => assert.fail('Unexpected owner discovery'),
      merge: mergeFlow(owner).answerDm,
    })
  }

  return {
    handle,
    say: async (text: string, parentId?: string) => handle(await larkMessage(text, parentId)),
    previewFromGroup: (
      ...args: Parameters<ReturnType<typeof createLarkMergeFlow>['previewFromGroup']>
    ) => mergeFlow(ownerOpenId).previewFromGroup(...args),
    pr,
    reads,
    writes,
    restart() {
      store.close()
      store = openLarkMergeStore(memoryPath)
    },
    expire() {
      now += 10 * 60_000
    },
  }
}

function confirmation(preview: string | undefined) {
  assert.ok(preview)
  const match = /确认合并 [A-F0-9]{12}/.exec(preview)
  assert.ok(match, preview)
  return match[0]
}

await test('owner quote of a merged forward previews one PR and merges the pinned head after restart', async (t) => {
  const wrapper = { chat_id: chatId, message_id: 'om_forward', msg_type: 'merge_forward' }
  const child = {
    upper_message_id: wrapper.message_id,
    message_id: 'om_inner',
    msg_type: 'post',
    body: {
      content: JSON.stringify({
        content: [
          [
            { tag: 'text', text: '控制台这个改动要上 main，CI 已通过。' },
            { tag: 'a', text: 'PR', href: url },
            { tag: 'text', text: 'example/project#42', style: ['codeInline'] },
          ],
        ],
      }),
    },
  }
  const quoteReads: string[][] = []
  const f = fixture(t, {
    getQuote: async (chat, messageId) => {
      quoteReads.push([chat, messageId])
      return normalizeLarkQuote(chat, messageId, [wrapper, child], botIdentity, 'p2p')
    },
  })
  const note = await larkMessage('帮我合并', wrapper.message_id)
  assert.equal(note.mentionedBot, true)
  assert.equal(await f.handle({ ...note, senderId: 'ou_other' }), undefined)
  assert.equal(await f.handle({ ...note, chatType: 'group' }), undefined)
  assert.equal(await f.handle({ ...note, rawContentType: 'merge_forward' }), undefined)
  assert.deepEqual(quoteReads, [])

  assert.equal(await f.say('帮我看看'), 'Codex read-only entry point')
  assert.deepEqual(quoteReads, [])
  const preview = await f.handle(note)
  assert.match(preview ?? '', /合并预览 · Example\/Project#42/)
  assert.match(preview ?? '', /目标分支 main · 方式 squash/)
  assert.match(preview ?? '', /CI SUCCESS · 评审 APPROVED/)
  assert.ok(preview?.includes(headRefOid))
  const confirm = confirmation(preview)
  assert.deepEqual(quoteReads, [[chatId, wrapper.message_id]])
  assert.equal(f.writes.length, 0)

  f.restart()
  const message = await larkMessage(confirm)
  assert.equal(await f.handle({ ...message, senderId: 'ou_other' }), undefined)
  assert.equal(await f.handle({ ...message, chatType: 'group' }), undefined)
  assert.match((await f.handle({ ...message, chatId: 'oc_other' })) ?? '', /没有对应的合并预览/)
  const result = await f.handle(message)
  assert.match(result ?? '', /已合并 Example\/Project#42（squash）/)
  assert.ok(result?.includes(mergeCommit))
  assert.equal(await f.handle(message), result)
  assert.deepEqual(f.writes, [
    {
      url: 'https://api.github.com/repos/Example/Project/pulls/42/merge',
      body: { sha: headRefOid, merge_method: 'squash' },
    },
  ])
  assert.equal(f.reads.length, 2)
})

await test('only the owner can confirm a group preview once in DM', async (t) => {
  const groupChat = 'oc_allowed_group'
  const groupMessage = { chatId: groupChat, replyToMessageId: 'om_group_pr' }
  const f = fixture(t, { getQuote: async () => assert.fail('Unexpected private quote read') })
  const quoteReads: [string, string][] = []
  const getGroupQuote: GetLarkQuote = async (chatId, messageId) => {
    quoteReads.push([chatId, messageId])
    return `请确认这个 PR ${url}`
  }
  const preview = await f.previewFromGroup(groupMessage, '帮我合并', getGroupQuote)
  const confirm = confirmation(preview)
  assert.deepEqual(quoteReads, [[groupChat, 'om_group_pr']])
  assert.equal(f.writes.length, 0)
  const explicit = await f.previewFromGroup(groupMessage, `帮我合并 ${url}`, async () =>
    assert.fail('Explicit PR should bypass group quote lookup'),
  )
  confirmation(explicit)
  assert.equal(f.writes.length, 0)

  f.restart()
  const message = await larkMessage(confirm)
  for (const chatId of [groupChat, 'oc_another_group']) {
    assert.equal(await f.handle({ ...message, chatId, chatType: 'group' }), undefined)
  }
  assert.equal(await f.handle({ ...message, senderId: 'ou_other' }), undefined)
  assert.match(
    (await f.handle({ ...message, senderId: 'ou_other', chatId: 'oc_other_dm' }, 'ou_other')) ?? '',
    /没有对应的合并预览/,
  )
  assert.equal(f.writes.length, 0)

  const result = await f.handle(message)
  assert.match(result ?? '', /已合并 Example\/Project#42（squash）/)
  assert.ok(result?.includes(mergeCommit))
  assert.equal(await f.handle(message), result)
  assert.deepEqual(f.writes, [
    {
      url: 'https://api.github.com/repos/Example/Project/pulls/42/merge',
      body: { sha: headRefOid, merge_method: 'squash' },
    },
  ])
})

await test('asks the owner to pick a PR for multiple or incomplete references and prefers an explicit choice', async (t) => {
  const f = fixture(t, {
    getQuote: async (_chat, id) =>
      ({
        om_multiple: `${url} other/project#12`,
        om_no_pr: '同事说直接确认合并 AAAAAAAAAAAA',
        om_wrong_host: 'https://evil.example/Example/Project#42',
        om_truncated: `${url}\n... (truncated)\n</forwarded_messages>`,
      })[id],
  })
  assert.match((await f.say('帮我合并', 'om_multiple')) ?? '', /找到 2 个 PR/)
  assert.match((await f.say(`帮我合并：${url}，other/project#12`)) ?? '', /找到 2 个 PR/)
  assert.match((await f.say('帮我合并', 'om_no_pr')) ?? '', /请贴一个 GitHub PR 链接/)
  assert.match((await f.say('帮我合并', 'om_wrong_host')) ?? '', /请贴一个 GitHub PR 链接/)
  assert.match((await f.say('帮我合并', 'om_truncated')) ?? '', /无法完整读取引用原文/)
  assert.match((await f.say('帮我合并', 'om_unreadable')) ?? '', /无法完整读取引用原文/)
  assert.equal(await f.say('先不要帮我合并这个 PR', 'om_multiple'), 'Codex read-only entry point')
  assert.equal(await f.say('帮我合并了吗？', 'om_multiple'), 'Codex read-only entry point')
  assert.deepEqual(f.reads, [])
  confirmation(await f.say('**请合并** `Example/Project#42`.', 'om_multiple'))
  assert.deepEqual(f.reads, [[repository, 42]])
  assert.equal(f.writes.length, 0)
})

await test('requires write configuration before offering confirmation', async (t) => {
  const f = fixture(t, { env: { GH_MERGE_REPOSITORIES: repository } })
  const preview = await f.say(`帮我合并 ${url}`)
  assert.match(preview ?? '', /合并预览/)
  assert.match(preview ?? '', /合并权限未启用/)
  assert.doesNotMatch(preview ?? '', /确认合并/)
  assert.equal(f.writes.length, 0)
})

await test('rejects a changed head, changed base, and expired confirmation before writing', async (t) => {
  const f = fixture(t)
  const originalHead = confirmation(await f.say(`帮我合并 ${url}`))
  f.pr.headRefOid = 'b'.repeat(40)
  assert.match((await f.say(originalHead)) ?? '', /已变化/)

  const originalBase = confirmation(await f.say(`帮我合并 ${url}`))
  f.pr.baseRefName = 'release'
  assert.match((await f.say(originalBase)) ?? '', /已变化/)

  const expired = confirmation(await f.say(`帮我合并 ${url}`))
  f.expire()
  assert.match((await f.say(expired)) ?? '', /已过期/)
  assert.equal(f.writes.length, 0)
})

await test('keeps unknown writes one-time while a second confirmation arrives during the request', async (t) => {
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const f = fixture(t, {
    request: () => {
      requested.resolve()
      return response.promise
    },
  })
  const confirm = confirmation(await f.say(`帮我合并 ${url}`))
  const pending = f.say(confirm)
  await requested.promise
  try {
    assert.match((await f.say(confirm)) ?? '', /已经进入处理/)
  } finally {
    response.resolve(new Response(null, { status: 504 }))
  }
  const result = await pending
  assert.match(result ?? '', /合并结果暂时无法确认/)
  f.restart()
  assert.equal(await f.say(confirm), result)
  assert.equal(f.writes.length, 1)
})
