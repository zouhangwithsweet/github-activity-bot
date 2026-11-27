import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CodexAnswerError } from '../src/agent.ts'
import { trackGroupGitHubAccess } from '../src/lark-group-work.ts'
import { createLarkGroupRouter } from '../src/lark-group.ts'
import {
  createLarkConversations,
  larkSessionStatus,
  openRememberedConversation,
} from '../src/lark-handler.ts'
import { openLarkMemory } from '../src/lark-memory.ts'

const identity = { appId: 'cli_app', ownerOpenId: 'ou_owner' }

await test('adopts the handwritten memory schema and leaves the GitHub alert outbox intact', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-legacy-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const identityKey = createHash('sha256')
    .update(JSON.stringify([identity.appId, identity.ownerOpenId]))
    .digest('hex')
  const identityDir = join(stateDir, identityKey)
  mkdirSync(identityDir)
  const databasePath = join(identityDir, 'memory.sqlite')
  const group = 'group:oc_chat:omt_topic'
  const dm = 'dm:oc_private'
  const outboxSchema = `CREATE TABLE github_alert_outbox (
    id TEXT PRIMARY KEY,
    recipient_open_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at_ms INTEGER NOT NULL,
    claimed_at_ms INTEGER,
    sent_at_ms INTEGER,
    reason TEXT
  ) STRICT`
  const legacy = new DatabaseSync(databasePath)
  try {
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE sessions (
        scope TEXT PRIMARY KEY,
        native_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE group_anchors (
        sequence INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        anchor_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        thread_id TEXT,
        UNIQUE (chat_id, anchor_key)
      ) STRICT;
      CREATE INDEX group_anchors_by_chat ON group_anchors (chat_id, sequence DESC);
      CREATE TABLE group_repositories (
        scope TEXT NOT NULL,
        repository TEXT NOT NULL,
        PRIMARY KEY (scope, repository)
      ) STRICT;
      CREATE TABLE private_group_sessions (scope TEXT PRIMARY KEY) STRICT;
      ${outboxSchema};
      INSERT INTO github_alert_outbox (id, recipient_open_id, text, status, attempts, due_at_ms, sent_at_ms)
        VALUES ('alert-existing', 'ou_owner', 'An earlier CI alert', 'sent', 2, 100, 200);
    `)
    const insertSession = legacy.prepare('INSERT INTO sessions VALUES (?, ?)')
    insertSession.run(group, 'legacy-group')
    insertSession.run(dm, 'legacy-dm')
    const insertAnchor = legacy.prepare('INSERT INTO group_anchors VALUES (?, ?, ?, ?, ?)')
    insertAnchor.run(12, 'oc_chat', 'om_first', group, null)
    insertAnchor.run(31, 'oc_chat', 'om_reply', group, 'omt_topic')
    legacy.prepare('INSERT INTO group_repositories VALUES (?, ?)').run(group, 'example/legacy')
    legacy.prepare('INSERT INTO private_group_sessions VALUES (?)').run(group)
  } finally {
    legacy.close()
  }

  const memory = openLarkMemory(stateDir, identity)
  try {
    assert.equal(memory.databasePath, databasePath)
    assert.equal(memory.getSession(group), 'legacy-group')
    assert.equal(memory.getSession(dm), 'legacy-dm')
    assert.deepEqual(memory.getSessionInfo(dm), {
      nativeId: 'legacy-dm',
      lastUsedAt: null,
      creationReason: null,
      resetRequested: false,
    })
    assert.deepEqual(memory.getGroupAnchors('oc_chat'), [
      { key: 'om_first', sessionKey: group },
      { key: 'om_reply', sessionKey: group, threadId: 'omt_topic' },
    ])
    assert.deepEqual(memory.getGroupRepositories(group), ['example/legacy'])
    assert.equal(memory.isGroupPrivate(group), true)
    memory.saveSession(dm, 'new-dm')
    memory.saveGroupAnchor('oc_chat', { key: 'om_first', sessionKey: group, threadId: 'omt_topic' })
    memory.rememberGroupRepository(group, 'EXAMPLE/New')
  } finally {
    memory.close()
  }

  const restored = openLarkMemory(stateDir, identity)
  try {
    assert.equal(restored.getSession(group), 'legacy-group')
    assert.equal(restored.getSession(dm), 'new-dm')
    assert.deepEqual(restored.getGroupAnchors('oc_chat'), [
      { key: 'om_reply', sessionKey: group, threadId: 'omt_topic' },
      { key: 'om_first', sessionKey: group, threadId: 'omt_topic' },
    ])
    assert.deepEqual(restored.getGroupRepositories(group), ['example/legacy', 'example/new'])
    assert.equal(restored.isGroupPrivate(group), true)
  } finally {
    restored.close()
  }

  const inspected = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const definition = inspected
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'github_alert_outbox'")
      .get()
    assert.equal(definition?.sql, outboxSchema)
    assert.deepEqual(
      inspected
        .prepare('SELECT * FROM github_alert_outbox')
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: 'alert-existing',
          recipient_open_id: 'ou_owner',
          text: 'An earlier CI alert',
          status: 'sent',
          attempts: 2,
          due_at_ms: 100,
          claimed_at_ms: null,
          sent_at_ms: 200,
          reason: null,
        },
      ],
    )
  } finally {
    inspected.close()
  }
})

await test('persists pending reset without touching or deleting the remembered session', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-reset-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['Date'], now: 100 })
  const scope = 'dm:oc_private'
  const initial = openLarkMemory(stateDir, identity)
  try {
    assert.equal(initial.requestSessionReset(scope), false)
    initial.saveSession(scope, 'first', 'new')
    assert.equal(initial.getSessionInfo(scope)?.lastUsedAt, 100)
    t.mock.timers.setTime(200)
    initial.touchSession(scope, 'stale')
    assert.equal(initial.getSessionInfo(scope)?.lastUsedAt, 100)
    initial.touchSession(scope, 'first')
    assert.equal(initial.getSessionInfo(scope)?.lastUsedAt, 200)
    assert.equal(initial.requestSessionReset(scope), true)
  } finally {
    initial.close()
  }

  const restored = openLarkMemory(stateDir, identity)
  try {
    t.mock.timers.setTime(300)
    restored.touchSession(scope, 'first')
    assert.deepEqual(restored.getSessionInfo(scope), {
      nativeId: 'first',
      lastUsedAt: 200,
      creationReason: 'new',
      resetRequested: true,
    })
    restored.saveSession(scope, 'replacement', 'reset')
    assert.deepEqual(restored.getSessionInfo(scope), {
      nativeId: 'replacement',
      lastUsedAt: 300,
      creationReason: 'reset',
      resetRequested: false,
    })
  } finally {
    restored.close()
  }
})

await test('restores session IDs, ordered group anchors, and private delivery state from disk', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const group = 'group:oc_chat:omt_topic'
  const dm = 'dm:oc_private'
  const first = openLarkMemory(stateDir, identity)
  try {
    assert.equal(statSync(dirname(first.cwd)).mode & 0o777, 0o700)
    assert.equal(statSync(first.cwd).mode & 0o777, 0o700)
    first.saveSession(group, 'codex-group')
    first.saveSession(dm, 'codex-dm')
    first.saveGroupAnchor('oc_chat', { key: 'old', sessionKey: group })
    first.saveGroupAnchor('oc_other', { key: 'old', sessionKey: 'group:oc_other:omt_other' })
    first.saveGroupAnchor('oc_chat', { key: 'replied', sessionKey: group, threadId: 'omt_topic' })
    first.saveGroupAnchor('oc_chat', { key: 'old', sessionKey: group, threadId: 'omt_topic' })
    first.rememberGroupRepository(group, 'Example/Repo')
    first.rememberGroupRepository(group, 'example/repo')
    first.markGroupPrivate(group)
  } finally {
    first.close()
  }

  const restored = openLarkMemory(stateDir, identity)
  try {
    assert.equal(restored.cwd, first.cwd)
    assert.equal(restored.getSession(group), 'codex-group')
    assert.equal(restored.getSession(dm), 'codex-dm')
    assert.deepEqual(restored.getGroupAnchors('oc_chat'), [
      { key: 'replied', sessionKey: group, threadId: 'omt_topic' },
      { key: 'old', sessionKey: group, threadId: 'omt_topic' },
    ])
    assert.deepEqual(restored.getGroupAnchors('oc_other'), [
      { key: 'old', sessionKey: 'group:oc_other:omt_other' },
    ])
    assert.deepEqual(restored.getGroupRepositories(group), ['example/repo'])
    assert.equal(restored.isGroupPrivate(group), true)
    assert.equal(restored.isGroupPrivate(dm), false)
  } finally {
    restored.close()
  }
})

await test('separates bot and owner identities and conditionally removes a missing native session', (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const original = openLarkMemory(stateDir, identity)
  const concurrent = openLarkMemory(stateDir, identity)
  const otherOwner = openLarkMemory(stateDir, { ...identity, ownerOpenId: 'ou_other' })
  const otherApp = openLarkMemory(stateDir, { ...identity, appId: 'cli_other' })
  try {
    const group = 'group:oc_chat:omt_topic'
    original.saveSession(group, 'old')
    original.saveGroupAnchor('oc_chat', { key: 'old', sessionKey: group })
    original.rememberGroupRepository(group, 'example/repo')
    original.markGroupPrivate(group)
    concurrent.saveSession(group, 'replacement')
    original.forgetSession(group, 'old')
    assert.equal(original.getSession(group), 'replacement')

    for (const memory of [otherOwner, otherApp]) {
      assert.notEqual(memory.cwd, original.cwd)
      assert.equal(memory.getSession(group), undefined)
      assert.deepEqual(memory.getGroupAnchors('oc_chat'), [])
      assert.deepEqual(memory.getGroupRepositories(group), [])
      assert.equal(memory.isGroupPrivate(group), false)
    }

    original.forgetSession(group, 'replacement')
    assert.equal(concurrent.getSession(group), undefined)
  } finally {
    original.close()
    concurrent.close()
    otherOwner.close()
    otherApp.close()
  }
})

await test('restores an authorized group reply anchor without losing private delivery', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const options = { ownerOpenId: identity.ownerOpenId, allowedChatIds: ['oc_test'] }
  const mention = {
    chatType: 'group',
    chatId: 'oc_test',
    senderId: identity.ownerOpenId,
    messageId: 'om_first',
    rawContentType: 'text',
    content: '查 example/private#3',
    mentionedBot: true,
  } as const
  const github = {
    list: async () => ({ login: 'owner', pullRequests: [], unavailableRepositories: [] }),
    detail: async () => null,
    checks: async () => null,
    reviews: async () => null,
  }
  const original = openLarkMemory(stateDir, identity)
  let groupScope: string
  try {
    const router = createLarkGroupRouter({ ...options, memory: original })
    const start = router.route(mention)
    assert.ok(start)
    groupScope = start.sessionKey
    router.recordReply(start, 'om_bot', 'omt_thread')
    const access = trackGroupGitHubAccess(github, async () => false, {
      memory: original,
      scope: groupScope,
    })
    await access.tools.detail('example/private', 3)
    assert.equal(await access.canReplyInGroup(), false)
  } finally {
    original.close()
  }

  const restored = openLarkMemory(stateDir, identity)
  try {
    const router = createLarkGroupRouter({ ...options, memory: restored })
    const followUp = {
      ...mention,
      messageId: 'om_later',
      content: '只看最新提交',
      mentionedBot: false,
      replyToMessageId: 'om_bot',
      threadId: 'omt_thread',
    }
    assert.equal(router.route(followUp)?.sessionKey, groupScope)
    assert.equal(router.route({ ...followUp, senderId: 'ou_other' }), undefined)
    const access = trackGroupGitHubAccess(github, async () => true, {
      memory: restored,
      scope: groupScope,
    })
    assert.equal(await access.canReplyInGroup(), false)
  } finally {
    restored.close()
  }
})

await test('saves a replacement as soon as it opens and preserves the prior binding on open errors', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const memory = openLarkMemory(stateDir, identity)
  try {
    const scope = 'dm:oc_private'
    memory.saveSession(scope, 'old')
    await assert.rejects(
      openRememberedConversation(scope, memory, async () => {
        throw new CodexAnswerError({ stage: 'session_start', code: 'rpc_error' })
      }),
    )
    assert.equal(memory.getSession(scope), 'old')

    const attempted: (string | undefined)[] = []
    const replacement = await openRememberedConversation(scope, memory, async (resume) => {
      attempted.push(resume)
      if (resume) {
        throw new CodexAnswerError({ stage: 'session_start', code: 'session_not_found' })
      }
      return {
        id: 'new',
        answer: async () => 'Latest result',
        close: async () => undefined,
      }
    })
    assert.deepEqual(attempted, ['old', undefined])
    assert.equal(memory.getSession(scope), 'new')
    assert.equal(memory.getSessionInfo(scope)?.creationReason, 'missing')
    assert.equal(await replacement.answer('只看最新提交'), 'Latest result')
    assert.equal(memory.getSession(scope), 'new')
    await replacement.close()
  } finally {
    memory.close()
  }
})

await test('resumes the first thread after a turn timeout and Bot restart, then resets just that scope', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'lark-memory-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const dmScope = 'dm:oc_private'
  const groupScope = 'group:oc_group:omt_topic'
  const opened: (string | undefined)[] = []
  const closed: string[] = []
  let timeout = true
  const open = async (resume?: string) => {
    opened.push(resume)
    const id = resume ?? `native-${opened.length}`
    return {
      id,
      answer: async () => {
        if (timeout) {
          timeout = false
          throw new CodexAnswerError({ stage: 'turn', code: 'timeout' })
        }
        return id
      },
      close: async () => {
        closed.push(id)
      },
    }
  }
  const original = openLarkMemory(stateDir, identity)
  const first = createLarkConversations((scope) =>
    openRememberedConversation(scope, original, open),
  )
  try {
    original.saveSession(groupScope, 'group-native')
    await assert.rejects(first.answer('first question', dmScope), CodexAnswerError)
    assert.equal(original.getSession(dmScope), 'native-1')
    assert.equal(original.getSessionInfo(dmScope)?.creationReason, 'first_use')
  } finally {
    await first.close()
    original.close()
  }

  const restored = openLarkMemory(stateDir, identity)
  const chats = createLarkConversations((scope) =>
    openRememberedConversation(scope, restored, open),
  )
  try {
    assert.equal(await chats.answer('retry', dmScope), 'native-1')
    assert.match(larkSessionStatus(restored, dmScope), /native-1/)
    assert.ok(!larkSessionStatus(restored, groupScope).includes('group-native'))
    assert.equal(await chats.reset(dmScope, () => restored.requestSessionReset(dmScope)), true)
    assert.match(larkSessionStatus(restored, dmScope), /已重置/)
    assert.deepEqual(opened, [undefined, 'native-1'])
    assert.equal(await chats.answer('next question', dmScope), 'native-3')
    assert.equal(restored.getSessionInfo(dmScope)?.creationReason, 'manual_reset')
    assert.equal(restored.getSession(groupScope), 'group-native')
    assert.deepEqual(closed, ['native-1', 'native-1'])
  } finally {
    await chats.close()
    restored.close()
  }
})
