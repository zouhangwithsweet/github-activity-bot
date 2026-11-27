import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { PullRequestDetail } from '../src/github.ts'
import { answerLarkMessage } from '../src/lark-handler.ts'
import { createPullRequestReview, parsePullRequestReview } from '../src/pull-request-review.ts'

const repository = 'Example/Website'
const number = 42
const url = 'https://github.com/Example/Website/pull/42'
const request = { repository, number, routes: [] }
const head = 'a'.repeat(40)
const preview = new URL('https://site-a1b2c3d4e-example.vercel.app')
const signal = new AbortController().signal
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function detail(paths: string[]): PullRequestDetail {
  return {
    repository,
    number,
    url,
    title: 'Update the marketing site',
    body: '',
    bodyTruncated: false,
    state: 'OPEN',
    draft: false,
    baseRefName: 'main',
    headRefName: 'review',
    headRefOid: head,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    checks: 'SUCCESS',
    changedFiles: paths.length,
    additions: paths.length,
    deletions: 0,
    files: {
      page: 1,
      nextPage: null,
      limitedByGitHub: false,
      entries: paths.map((path) => ({
        path,
        status: 'modified',
        previousPath: null,
        additions: 1,
        deletions: 0,
        patchExcerpt: '+fixture',
        patchTruncated: false,
      })),
    },
  }
}

await test('routes only the bound owner PR review command through private chat', async () => {
  assert.deepEqual(parsePullRequestReview(`[PR](${url})`), request)
  assert.deepEqual(parsePullRequestReview(`/review ${url} / /pricing`), {
    ...request,
    routes: ['/', '/pricing'],
  })
  assert.equal(parsePullRequestReview(`/review ${url} //other.example`), 'invalid')
  assert.equal(parsePullRequestReview(`${url} 检查 CI`), undefined)
  let calls = 0
  const message = {
    chatType: 'p2p',
    chatId: 'oc_owner',
    senderId: 'ou_owner',
    rawContentType: 'text',
    content: `${url} 看看改动`,
  } as const
  const options = {
    ownerOpenId: 'ou_owner',
    run: async () => assert.fail('review must use the dedicated session'),
    query: async () => assert.fail('unexpected PR list'),
    review: async (received: unknown) => {
      calls++
      assert.deepEqual(received, request)
      return 'review'
    },
    getQuote: async () => assert.fail('unexpected quote lookup'),
    onUnconfiguredOwner: () => assert.fail('unexpected owner lookup'),
  }
  assert.equal(await answerLarkMessage({ ...message, chatType: 'group' }, options), undefined)
  assert.equal(await answerLarkMessage({ ...message, senderId: 'ou_someone' }, options), undefined)
  assert.equal(await answerLarkMessage(message, options), 'review')
  assert.equal(calls, 1)
})

await test('evaluates images of the affected route in both sizes and summarizes mixed changes', async () => {
  const pr = detail(['apps/site/app/(website)/pricing/page.tsx', 'apps/api/src/billing.ts'])
  const paths: string[] = []
  const review = createPullRequestReview({
    detail: async () => pr,
    signal,
    preview: async (name, sha) => {
      assert.equal(name, repository)
      assert.equal(sha, head)
      return { kind: 'ready', origin: preview }
    },
    capture: async (origin, routes, directory) => {
      assert.equal(origin.href, preview.href)
      assert.deepEqual(routes, ['/pricing'])
      const viewports = [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]
      const captures = await Promise.all(
        viewports.map(async (viewport) => {
          const path = join(directory, `${viewport.width}.png`)
          paths.push(path)
          await writeFile(path, png)
          return { route: '/pricing', path, ...viewport }
        }),
      )
      return { captures, failures: [] }
    },
    analyze: async (prompt, images) => {
      assert.deepEqual(images, paths)
      assert.match(prompt, /1440×900/)
      assert.match(prompt, /390×844/)
      assert.match(prompt, /billing\.ts/)
      return '手机端定价卡片有重叠。后端改动涉及计费接口。'
    },
  })
  const result = await review(request)
  assert.match(result.text, /手机端定价卡片有重叠/)
  assert.match(result.text, /计费接口/)
  assert.match(result.text, /图 2 · \/pricing · 390×844/)
  assert.deepEqual(
    result.images.map((image) => image.png),
    [png, png],
  )
  for (const path of paths) await assert.rejects(access(path), { code: 'ENOENT' })
})

await test('delivers backend-only summaries and reports missing UI previews without inventing screenshots', async () => {
  let paths = ['apps/api/src/handler.ts']
  let previewReads = 0
  const review = createPullRequestReview({
    detail: async () => detail(paths),
    signal,
    preview: async () => {
      previewReads++
      return { kind: 'missing' }
    },
    capture: async () => assert.fail('unexpected browser'),
    analyze: async (prompt, images) => {
      assert.deepEqual(images, [])
      assert.match(prompt, /fixture/)
      return '已总结代码改动。'
    },
  })
  assert.match((await review(request)).text, /已总结代码改动/)
  assert.equal(previewReads, 0)
  paths = ['apps/site/app/page.tsx']
  const result = await review(request)
  assert.match(result.text, /已总结代码改动/)
  assert.match(result.text, /缺图 \/ · GitHub 没有返回/)
  assert.deepEqual(result.images, [])
  assert.equal(previewReads, 1)
})

await test('does not deliver material if a new PR head appears during the review', async () => {
  const pr = detail(['server/change.ts'])
  const review = createPullRequestReview({
    signal,
    detail: async (_repository, _number, page) =>
      page ? pr : { ...pr, headRefOid: 'b'.repeat(40) },
    preview: async () => assert.fail('unexpected preview lookup'),
    capture: async () => assert.fail('unexpected browser'),
    analyze: async () => 'Summary of obsolete head.',
  })
  const result = await review(request)
  assert.match(result.text, /当前提交已变化/)
  assert.doesNotMatch(result.text, /obsolete/)
  assert.deepEqual(result.images, [])
})
