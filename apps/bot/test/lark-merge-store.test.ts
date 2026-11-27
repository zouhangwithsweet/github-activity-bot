import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { openLarkMergeStore, type LarkMergeRequest } from '../src/lark-merge-store.ts'

const request: LarkMergeRequest = {
  chatId: 'oc_owner',
  repository: 'Example/Bot',
  number: 42,
  headSha: '1'.repeat(40),
  baseRef: 'main',
  method: 'squash',
  expiresAt: 1_000,
}

function scratchMemoryPath(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'lark-merge-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'memory.sqlite')
}

await test('claims a merge token once from its own chat and remembers the first result', (t) => {
  const path = scratchMemoryPath(t)
  const store = openLarkMergeStore(path)
  const peer = openLarkMergeStore(path)
  try {
    const { token } = store.create(request)
    assert.match(token, /^[A-F0-9]{12}$/)
    store.finish(token, 'must be ignored before claim')
    assert.deepEqual(peer.claim('oc_someone_else', token, 100), { status: 'missing' })
    assert.deepEqual(peer.claim(request.chatId, token.toLowerCase(), 100), {
      status: 'claimed',
      request,
    })
    assert.deepEqual(store.claim(request.chatId, token, 100), { status: 'processing' })
    store.finish(token, '已合并 PR #42')
    peer.finish(token.toLowerCase(), 'must preserve the first result')
    assert.deepEqual(store.claim('oc_someone_else', token, 1_001), { status: 'missing' })
    assert.deepEqual(peer.claim(request.chatId, token.toLowerCase(), 1_001), {
      status: 'finished',
      message: '已合并 PR #42',
    })
  } finally {
    peer.close()
    store.close()
  }
})

await test('keeps pending and in-flight confirmations durable without retrying a claimed merge', (t) => {
  const path = scratchMemoryPath(t)
  let store = openLarkMergeStore(path)
  try {
    const crashed = store.create(request).token
    const pending = store.create(request).token
    const expired = store.create({ ...request, expiresAt: 150 }).token
    assert.deepEqual(store.claim(request.chatId, crashed, 100), { status: 'claimed', request })
    store.close()

    store = openLarkMergeStore(path)
    assert.deepEqual(store.claim(request.chatId, expired, 150), { status: 'expired' })
    assert.deepEqual(store.claim(request.chatId, pending, 200), { status: 'claimed', request })
    assert.deepEqual(store.claim(request.chatId, crashed, 2_000), { status: 'processing' })

    store.finish(pending, 'merge rejected')
    store.close()
    store = openLarkMergeStore(path)
    assert.deepEqual(store.claim(request.chatId, pending, 2_000), {
      status: 'finished',
      message: 'merge rejected',
    })
    assert.deepEqual(store.claim(request.chatId, expired, 2_000), { status: 'expired' })
  } finally {
    store.close()
  }
})
