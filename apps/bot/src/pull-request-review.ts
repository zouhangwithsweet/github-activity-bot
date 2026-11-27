import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewPullRequestWithCodex } from './agent.ts'
import type { PullRequestPreviewQuery } from './github-preview.ts'
import { isRepositoryName, type PullRequestDetailQuery } from './github.ts'
import { capturePullRequestPreview } from './preview-capture.ts'

export interface PullRequestReviewRequest {
  repository: string
  number: number
  routes: string[]
}

const maxRoutes = 3
const routePath = /^\/(?!\/)(?:[a-z\d/_~.%-])*$/i
const reviewPrefix = /^(?:\/review(?:\s+|$)|(?:帮我)?(?:看看改动|看改动|审查改动)\s+)/i
const reviewSuffix = /\s+(?:看看改动|看改动|审查改动)[。！!]?$/i
const reviewHelp =
  '发 /review 加一个 GitHub PR 链接或 owner/repo#编号。可在末尾加页面路径，如 /pricing。'

export function parsePullRequestReview(
  text: string,
): PullRequestReviewRequest | 'invalid' | undefined {
  const message = text.trim()
  const explicit = reviewPrefix.test(message) || reviewSuffix.test(message)
  const [reference, ...routes] = message
    .replace(reviewPrefix, '')
    .replace(reviewSuffix, '')
    .replace(/\[([^\]\r\n]*)\]\((https:\/\/github\.com\/[^\s()]+)\)/gi, '$2')
    .trim()
    .split(/\s+/)
  if (routes.length && !explicit) return

  const match =
    /^(?:https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?|([^#]+)#([1-9]\d*))$/i.exec(
      reference.replace(/^[<`]+|[>`]+$/g, ''),
    )
  const repository = match?.[1] ?? match?.[3]
  const number = Number(match?.[2] ?? match?.[4])
  if (
    !repository ||
    !isRepositoryName(repository) ||
    !Number.isSafeInteger(number) ||
    number > 2_147_483_647
  )
    return explicit ? 'invalid' : undefined
  if (routes.length > maxRoutes || routes.some((route) => !routePath.test(route))) return 'invalid'
  return { repository, number, routes: [...new Set(routes)] }
}

function isFrontend(path: string) {
  return (
    !/(?:^|\/)(?:api|backend|server|workers?|db|migrations|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(
      path,
    ) &&
    (/\.(?:tsx|jsx|vue|svelte|html|css|scss|sass|less|mdx)$/i.test(path) ||
      /(?:^|\/)(?:public|styles|components|assets|frontend|website)\//i.test(path))
  )
}

function routeForFile(path: string) {
  const app = /(?:^|\/)app\/((?:[^/]+\/)*)page\.(?:[jt]sx?|mdx)$/i.exec(path)
  const pages = /(?:^|\/)pages\/(.*)\.(?:[jt]sx?|mdx)$/i.exec(path)
  if (!app && !pages) return
  const segments = (app?.[1] ?? pages?.[1] ?? '').split('/').filter(Boolean)
  if (segments.some((segment) => segment.startsWith('[') || segment.startsWith('@'))) return
  if (pages && /^(_|api$)/i.test(segments[0] ?? '')) return
  if (pages && segments.at(-1) === 'index') segments.pop()
  const route = '/' + segments.filter((part) => !/^\(.*\)$/.test(part)).join('/')
  return routePath.test(route) ? route : undefined
}

export interface PullRequestReviewReport {
  text: string
  images: { label: string; png: Buffer }[]
}

const previewReasons = {
  missing: 'GitHub 没有返回与当前提交匹配的预览地址。',
  pending: '当前提交的预览部署还未就绪。',
  unavailable: '暂时无法读取 GitHub 部署记录，请核对 Deployments 读取权限。',
  ambiguous: '当前提交有多个可用的预览部署，无法确定对应的网站。',
}

export function createPullRequestReview(options: {
  detail: PullRequestDetailQuery
  preview: PullRequestPreviewQuery
  capture?: typeof capturePullRequestPreview
  analyze?: typeof reviewPullRequestWithCodex
  signal: AbortSignal
}) {
  const { detail, preview, signal } = options
  const capture = options.capture ?? capturePullRequestPreview
  const analyze = options.analyze ?? reviewPullRequestWithCodex

  return async (
    request: PullRequestReviewRequest | 'invalid',
  ): Promise<PullRequestReviewReport> => {
    const message = (text: string) => ({ text, images: [] })
    if (request === 'invalid') return message(reviewHelp)
    signal.throwIfAborted()
    const { repository, number } = request
    const pr = await detail(repository, number, 1)
    if (
      !pr?.files ||
      pr.repository.toLowerCase() !== repository.toLowerCase() ||
      pr.number !== number
    ) {
      return message('暂时读不到这个 PR 的改动文件。请检查链接和 GitHub 读取权限。')
    }
    const heading = `PR 改动评审 · ${pr.repository}#${pr.number} · ${pr.headRefOid.slice(0, 8)}\n${pr.url}`
    const stale = () => message(`${heading}\n\n当前提交已变化或无法复核，请重新发起评审。`)
    const files = [...pr.files.entries]
    if (pr.files.nextPage !== null) {
      const next = await detail(repository, number, pr.files.nextPage).catch(() => null)
      if (next && next.headRefOid !== pr.headRefOid) return stale()
      if (next?.files && next.number === pr.number && next.repository === pr.repository) {
        files.push(...next.files.entries)
      }
    }
    signal.throwIfAborted()
    const frontend = files.filter(
      (file) => isFrontend(file.path) || (file.previousPath && isFrontend(file.previousPath)),
    )
    const inferred = [
      ...new Set(
        frontend
          .filter((file) => file.status !== 'removed')
          .flatMap((file) => routeForFile(file.path) ?? []),
      ),
    ]
    const routes = request.routes.length ? request.routes : inferred.slice(0, maxRoutes)
    const notes: string[] = []
    if (!routes.length && frontend.length) {
      routes.push('/')
      notes.push('截图使用首页。具体页面或交互状态可用 /review 指定对应路径。')
    }
    if (!request.routes.length && inferred.length > maxRoutes) {
      notes.push(`还有 ${inferred.length - maxRoutes} 个推断出的路径，可用 /review 指定后补截图。`)
    }
    if (files.length < pr.changedFiles)
      notes.push(`改动范围只覆盖 ${files.length}/${pr.changedFiles} 个文件。`)
    if (files.some((file) => !file.patchExcerpt || file.patchTruncated))
      notes.push('部分文件缺少完整 diff。')

    const directory = await mkdtemp(join(tmpdir(), 'github-bot-preview-'))
    try {
      let screenshots: Awaited<ReturnType<typeof capture>>['captures'] = []
      if (routes.length) {
        const deployment = await preview(pr.repository, pr.headRefOid, signal)
        if (deployment.kind === 'ready') {
          const result = await capture(deployment.origin, routes, directory, signal)
          screenshots = result.captures
          for (const failed of result.failures) {
            notes.push(`缺图 ${failed.route} · ${failed.width}×${failed.height} · ${failed.reason}`)
          }
        } else {
          notes.push(`缺图 ${routes.join('、')} · ${previewReasons[deployment.kind]}`)
        }
      }
      signal.throwIfAborted()
      const labels = screenshots.map((shot) => `${shot.route} · ${shot.width}×${shot.height}`)
      const prompt = JSON.stringify({
        repository: pr.repository,
        number: pr.number,
        head: pr.headRefOid,
        title: pr.title,
        description: pr.body,
        files,
        screenshots: labels,
        captureScope: '静态视口截图。跨域资源和实际页面交互未验证。',
        notes,
      })
      const paths = screenshots.map((shot) => shot.path)
      const critique = await analyze(prompt, paths, signal).catch(() => {
        const scope = files
          .slice(0, 6)
          .map((file) => `${file.path} (${file.status})`)
          .join('、')
        return `已读取的改动范围 · ${scope || '暂无文件'}\nCodex 点评暂不可用。`
      })
      signal.throwIfAborted()
      const latest = await detail(repository, number).catch(() => null)
      if (!latest || latest.headRefOid !== pr.headRefOid || latest.repository !== pr.repository)
        return stale()
      signal.throwIfAborted()
      const images = []
      for (const [index, path] of paths.entries()) {
        const png = await readFile(path).catch(() => undefined)
        if (png?.length && png.length <= 10 * 1024 * 1024)
          images.push({ label: labels[index], png })
        else notes.push(`缺图 ${labels[index]} · 截图文件不可用或超过上传限制`)
      }
      const attachments = images
        .map((image, index) => `图 ${index + 1} · ${image.label}`)
        .join('\n')
      return {
        text: [heading, critique, attachments, notes.join('\n')].filter(Boolean).join('\n\n'),
        images,
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
