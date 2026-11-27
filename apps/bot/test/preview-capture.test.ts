import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { chromium, type Browser, type Route } from 'playwright'
import { capturePullRequestPreview } from '../src/preview-capture.ts'

const preview = new URL('https://test-preview.vercel.app')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/woAAAAASUVORK5CYII=',
  'base64',
)

await test('turns a missing Chromium binary into an actionable failure', async (t) => {
  t.mock.method(chromium, 'launch', async () => {
    throw new Error("browserType.launch: Executable doesn't exist at /fake/runtime")
  })
  const result = await capturePullRequestPreview(preview, ['/'], tmpdir())
  assert.equal(result.captures.length, 0)
  assert.equal(result.failures.length, 2)
  for (const { reason } of result.failures) {
    assert.match(reason, /playwright install chromium/)
    assert.doesNotMatch(reason, /\/fake\/runtime/)
  }
})

await test('rejects private or non-Vercel origins, unsafe paths and excess routes before launch', async (t) => {
  const launch = t.mock.method(chromium, 'launch', () => assert.fail('must not launch'))
  for (const unsafe of [
    'http://test-preview.vercel.app',
    'https://vercel.app',
    'https://test-preview.vercel.app.example.org',
    'https://test-preview.vercel.app:444',
    'https://username:password@test-preview.vercel.app',
    'https://test-preview.vercel.app/path',
  ]) {
    const result = await capturePullRequestPreview(new URL(unsafe), ['/'], tmpdir())
    assert.equal(result.captures.length, 0)
    assert.equal(result.failures.length, 2)
  }
  const result = await capturePullRequestPreview(
    preview,
    ['//example.org/a', '/\\example.org/a', 'https://example.org/a'],
    tmpdir(),
  )
  assert.equal(result.captures.length, 0)
  assert.equal(result.failures.length, 6)
  await assert.rejects(
    capturePullRequestPreview(preview, ['/', '/a', '/b', '/c'], tmpdir()),
    /最多.*3/,
  )
  assert.equal(launch.mock.callCount(), 0)
})

await test('captures both viewports and blocks non-GET requests, cross-origin requests and redirects', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gh-preview-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let browserClosed = false
  let contextsClosed = 0
  const fetches: string[] = []

  const browser = {
    async newContext(options: Parameters<Browser['newContext']>[0]) {
      assert.equal(options?.serviceWorkers, 'block')
      assert.equal(options.acceptDownloads, false)
      assert.equal(options.storageState, undefined)
      let handler: ((route: Route) => Promise<void>) | undefined
      let pageUrl = ''
      const mainFrame = {}

      async function request(url: string, method: string, navigation: boolean, redirect = false) {
        assert.ok(handler)
        let allowed = false
        let blocked = false
        const route = {
          request: () => ({
            url: () => url,
            method: () => method,
            isNavigationRequest: () => navigation,
            frame: () => mainFrame,
          }),
          async fetch(options: Parameters<Route['fetch']>[0]) {
            assert.equal(options?.maxRedirects, 0)
            assert.equal(options.maxRetries, 0)
            fetches.push(url)
            return {
              status: () => (redirect ? 302 : 200),
              headers: () => (redirect ? { location: 'https://external.example.org/' } : {}),
              async dispose() {},
            }
          },
          async abort() {
            blocked = true
          },
          async fulfill() {
            allowed = true
          },
        }
        await handler(route as unknown as Route)
        assert.notEqual(allowed, blocked)
        return allowed
      }

      return {
        async routeWebSocket(_pattern: string, intercept: (socket: { close(): void }) => void) {
          let closed = false
          intercept({
            close: () => {
              closed = true
            },
          })
          assert.equal(closed, true)
        },
        async route(_pattern: string, intercept: NonNullable<typeof handler>) {
          handler = intercept
        },
        async newPage() {
          return {
            mainFrame: () => mainFrame,
            url: () => pageUrl,
            async goto(url: string) {
              pageUrl = url
              assert.equal(await request('https://external.vercel.app/assets', 'GET', false), false)
              assert.equal(await request(new URL('/api', preview).href, 'POST', false), false)
              if (!(await request(url, 'GET', true, url.endsWith('/redirect'))))
                throw new Error('blocked')
              return { ok: () => true }
            },
            async waitForLoadState() {},
            async screenshot(options: { type: string }) {
              assert.equal(options.type, 'png')
              return png
            },
          }
        },
        async close() {
          contextsClosed += 1
        },
      }
    },
    async close() {
      browserClosed = true
    },
  } as unknown as Browser

  t.mock.method(chromium, 'launch', async (options?: Parameters<typeof chromium.launch>[0]) => {
    assert.equal(options?.chromiumSandbox, true)
    assert.deepEqual(Object.keys(options?.env ?? {}).sort(), ['PATH', 'TMPDIR'])
    return browser
  })

  const result = await capturePullRequestPreview(preview, ['/ready', '/redirect'], directory)
  assert.deepEqual(
    result.captures.map(({ route, width, height }) => [route, width, height]),
    [
      ['/ready', 1440, 900],
      ['/ready', 390, 844],
    ],
  )
  for (const { path } of result.captures) {
    assert.deepEqual(await readFile(path), png)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  assert.equal(result.failures.length, 2)
  assert.ok(
    result.failures.every(
      ({ route, reason }) => route === '/redirect' && reason.includes('重定向'),
    ),
  )
  assert.deepEqual(fetches.sort(), [
    `${preview.origin}/ready`,
    `${preview.origin}/ready`,
    `${preview.origin}/redirect`,
    `${preview.origin}/redirect`,
  ])
  assert.equal(contextsClosed, 4)
  assert.equal(browserClosed, true)
})
