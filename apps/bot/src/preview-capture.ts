import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page, Route } from 'playwright'

interface PreviewFrame {
  route: string
  width: number
  height: number
}

interface PreviewImage extends PreviewFrame {
  path: string
}

interface PreviewFailure extends PreviewFrame {
  reason: string
}

interface PreviewCaptures {
  captures: PreviewImage[]
  failures: PreviewFailure[]
}

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const
const maxRoutes = 3
const requestTimeoutMs = 6_000
const navigationTimeoutMs = 8_000
const screenshotTimeoutMs = 4_000

function validOrigin(url: URL) {
  return (
    url.protocol === 'https:' &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(url.hostname) &&
    !url.port &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  )
}

function hasExpectedOrigin(url: URL, origin: URL) {
  return url.protocol === 'https:' && url.origin === origin.origin && !url.username && !url.password
}

function previewUrl(origin: URL, route: string) {
  if (
    !route.startsWith('/') ||
    route.startsWith('//') ||
    /[\\\s]|:\/\//u.test(route) ||
    Array.from(route).some((character) => character < ' ' || character === '\u007f')
  ) {
    return
  }
  const url = new URL(route, origin)
  return hasExpectedOrigin(url, origin) ? url : undefined
}

function isMainNavigation(route: Route, page: Page) {
  const request = route.request()
  if (!request.isNavigationRequest()) return false
  try {
    return request.frame() === page.mainFrame()
  } catch {
    return false
  }
}

async function captureFrame(
  browser: Browser,
  origin: URL,
  url: URL,
  frame: PreviewFrame,
  path: string,
  signal?: AbortSignal,
): Promise<PreviewImage | PreviewFailure> {
  let context: BrowserContext | undefined
  let navigationIssue: string | undefined

  try {
    signal?.throwIfAborted()
    const mobile = frame.width === 390
    context = await browser.newContext({
      viewport: { width: frame.width, height: frame.height },
      deviceScaleFactor: 1,
      isMobile: mobile,
      hasTouch: mobile,
      acceptDownloads: false,
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    await context.routeWebSocket('**/*', (socket) => socket.close())
    await context.route('**/*', async (route) => {
      const request = route.request()
      const mainNavigation = isMainNavigation(route, page)
      if (!hasExpectedOrigin(new URL(request.url()), origin)) {
        if (mainNavigation) navigationIssue = '页面尝试跳转到预览域名之外。'
        await route.abort('blockedbyclient')
        return
      }
      if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        await route.abort('blockedbyclient')
        return
      }

      try {
        const response = await route.fetch({
          maxRedirects: 0,
          maxRetries: 0,
          timeout: requestTimeoutMs,
        })
        try {
          // Stop at the first redirect. Chromium may skip interception of redirected requests.
          const location = response.headers().location
          if (response.status() >= 300 && response.status() < 400 && location) {
            if (mainNavigation) {
              const sameOrigin =
                URL.canParse(location, request.url()) &&
                hasExpectedOrigin(new URL(location, request.url()), origin)
              navigationIssue = sameOrigin
                ? '预览页面返回重定向。请使用部署的最终页面路径。'
                : '预览页面重定向到了该部署域名之外。'
            }
            await route.abort('blockedbyclient')
            return
          }
          await route.fulfill({ response })
        } finally {
          await response.dispose()
        }
      } catch {
        if (mainNavigation) navigationIssue ??= '请求预览页面失败或超时。'
        await route.abort('failed').catch(() => undefined)
      }
    })

    const response = await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    })
    if (!response) return { ...frame, reason: '预览页面没有返回响应。' }
    if (!response.ok())
      return { ...frame, reason: `无法读取预览页面（HTTP ${response.status()}）。` }
    await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => undefined)
    if (navigationIssue || !hasExpectedOrigin(new URL(page.url()), origin)) {
      return { ...frame, reason: navigationIssue ?? '页面离开了预览域名。' }
    }

    const png = await page.screenshot({
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      timeout: screenshotTimeoutMs,
    })
    if (navigationIssue || !hasExpectedOrigin(new URL(page.url()), origin)) {
      return { ...frame, reason: navigationIssue ?? '截图时页面离开了预览域名。' }
    }
    signal?.throwIfAborted()
    await writeFile(path, png, { flag: 'wx', mode: 0o600, signal })
    return { ...frame, path }
  } catch {
    signal?.throwIfAborted()
    return { ...frame, reason: navigationIssue ?? '页面加载或截图失败。' }
  } finally {
    await context?.close().catch(() => undefined)
  }
}

export async function capturePullRequestPreview(
  origin: URL,
  routes: readonly string[],
  directory: string,
  signal?: AbortSignal,
): Promise<PreviewCaptures> {
  signal?.throwIfAborted()
  if (routes.length > maxRoutes) throw new Error('每次最多截图 3 个预览路径。')
  const requestedRoutes = routes.length ? routes : ['/']
  const result: PreviewCaptures = { captures: [], failures: [] }
  if (!validOrigin(origin)) {
    return {
      captures: [],
      failures: requestedRoutes.flatMap((route) =>
        viewports.map((viewport) => ({
          ...viewport,
          route,
          reason: '预览地址不是有效的 Vercel 部署域名。',
        })),
      ),
    }
  }

  const pages = []
  for (const route of requestedRoutes) {
    const url = previewUrl(origin, route)
    if (url) pages.push({ route, url })
    else {
      for (const viewport of viewports) {
        result.failures.push({ ...viewport, route, reason: '只接受以 / 开头的预览页面路径。' })
      }
    }
  }
  if (!pages.length) return result

  let browser: Browser
  try {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      timeout: 10_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
      args: [
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND',
      ],
    })
  } catch (error) {
    signal?.throwIfAborted()
    const reason =
      error instanceof Error &&
      /executable doesn't exist|playwright install|cannot find package 'playwright'/i.test(
        error.message,
      )
        ? '截图功能需要 Playwright Chromium。请运行 pnpm --dir apps/bot exec playwright install chromium。'
        : '无法启动 Chromium 沙箱。请检查浏览器安装和运行权限。'
    for (const { route } of pages) {
      for (const viewport of viewports) result.failures.push({ ...viewport, route, reason })
    }
    return result
  }

  let closing: Promise<void> | undefined
  const closeBrowser = () => (closing ??= browser.close().catch(() => undefined))
  const abortBrowser = () => {
    void closeBrowser()
  }
  signal?.addEventListener('abort', abortBrowser, { once: true })
  try {
    for (const [index, { route, url }] of pages.entries()) {
      signal?.throwIfAborted()
      const frames = await Promise.allSettled(
        viewports.map((viewport) =>
          captureFrame(
            browser,
            origin,
            url,
            { ...viewport, route },
            join(directory, `preview-${index + 1}-${viewport.width}x${viewport.height}.png`),
            signal,
          ),
        ),
      )
      signal?.throwIfAborted()
      for (const outcome of frames) {
        if (outcome.status === 'rejected') throw outcome.reason
        const frame = outcome.value
        if ('path' in frame) result.captures.push(frame)
        else result.failures.push(frame)
      }
    }
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener('abort', abortBrowser)
    await closeBrowser()
  }
}
