import type { createPullRequestMerger, MergeFailureReason } from './github-merge.ts'
import { isRepositoryName, type PullRequestDetail, type PullRequestDetailQuery } from './github.ts'
import type { openLarkMergeStore } from './lark-merge-store.ts'
import type { GetLarkQuote } from './lark-quote.ts'

type MergeIntent = { kind: 'preview'; text: string } | { kind: 'confirm'; token?: string }

interface MergeMessage {
  chatId: string
  replyToMessageId?: string
}

interface PullRequestReference {
  repository: string
  number: number
}

const references =
  /https?:\/\/[^\s<>()[\]{}"`，。；、！]+|(?<![\w./@%#-])([a-z0-9-]+\/[a-z0-9_.-]+)#([1-9]\d*)(?![\w/#-]|\.\w)/gi
const mergeVerb = '(?:合并|merge)'
const mergeTarget = '(?:PR引用|这[个条]|PR|拉取请求)'
const mergeRequest = new RegExp(
  `^(?:(?:请|麻烦)(?:你)?\\s*)?(?:(?:帮我|替我)\\s*)?(?:` +
    `${mergeVerb}(?:一下)?(?:[\\s:：,，、和]*${mergeTarget})*|把\\s*(?:${mergeTarget}\\s*)+${mergeVerb}(?:一下)?)` +
    '(?:\\s*(?:一下|了|吧|掉))*\\s*[。！!.]*$',
  'i',
)
const confirmationTtlMs = 10 * 60_000
const commitSha = /^[0-9a-f]{40}$/i

function parseReference(
  value: string,
  repository?: string,
  number?: string,
): PullRequestReference | undefined {
  if (!repository) {
    try {
      const url = new URL(value.replace(/[,.!?;]+$/, ''))
      if (url.origin !== 'https://github.com' || url.username || url.password) return
      const parts = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
      if (!parts) return
      repository = parts[1]
      number = parts[2]
    } catch {
      return
    }
  }
  const prNumber = Number(number)
  if (!isRepositoryName(repository) || !Number.isInteger(prNumber) || prNumber > 2_147_483_647)
    return
  return { repository, number: prNumber }
}

function pullRequestsIn(text: string) {
  const found = new Map<string, PullRequestReference>()
  for (const [value, repository, number] of text.matchAll(references)) {
    const pr = parseReference(value, repository, number)
    if (pr) found.set(`${pr.repository.toLowerCase()}#${pr.number}`, pr)
  }
  return [...found.values()]
}

export function parseLarkMergeIntent(text: string): MergeIntent | undefined {
  if (/^确认合并(?:\s|$)/.test(text)) {
    return { kind: 'confirm', token: /^确认合并\s+([a-f0-9]{12})$/i.exec(text)?.[1] }
  }
  if (/^\/merge(?:\s|$)/i.test(text)) return { kind: 'preview', text }

  // Recognize the user's imperative without interpreting quoted or forwarded prose as an instruction.
  const message = text
    .replace(/\[([^\]\r\n]*)\]\((https?:\/\/[^\s()]+)\)/gi, '$2')
    .replace(references, (value, repository: string | undefined, number: string | undefined) =>
      parseReference(value, repository, number) ? ' PR引用 ' : value,
    )
    .replace(/[*`]/g, '')
    .trim()
  if (mergeRequest.test(message)) return { kind: 'preview', text }
}

function prUrl({ repository, number }: PullRequestReference) {
  return `https://github.com/${repository}/pull/${number}`
}

function matchesReference(pr: PullRequestDetail, ref: PullRequestReference) {
  return pr.number === ref.number && pr.repository.toLowerCase() === ref.repository.toLowerCase()
}

function unavailable(pr: PullRequestDetail) {
  if (pr.state === 'MERGED') return '这个 PR 已经合并。'
  if (pr.state !== 'OPEN') return '这个 PR 已关闭。'
  if (pr.draft) return '这个 PR 还是草稿，请先在 GitHub 标为可评审。'
  if (pr.mergeable === 'CONFLICTING') return '这个 PR 有合并冲突，请先解决冲突。'
}

function oneLine(text: string) {
  return text
    .replace(/[\p{C}\s]+/gu, ' ')
    .trim()
    .slice(0, 200)
}

const blocked: Partial<Record<MergeFailureReason, string>> = {
  not_allowed: '这个仓库的合并权限未启用。',
  permission_or_protection: 'GitHub 拒绝合并。请检查写入权限和分支规则。',
  not_found_or_inaccessible: 'GitHub 写入凭据无法访问这个 PR。',
  cannot_merge: 'GitHub 当前无法合并这个 PR。请打开 PR 查看合并条件。',
  rate_limited: 'GitHub 限流了。稍后重新请求合并预览。',
}
const stale = 'PR 的提交、目标分支或合并方式已变化。请重新请求合并预览。'
const closing = 'Bot 正在关闭。请重启后重新请求合并预览。'

export function createLarkMergeFlow(options: {
  ownerOpenId: string
  detail: PullRequestDetailQuery
  merger: ReturnType<typeof createPullRequestMerger>
  store: ReturnType<typeof openLarkMergeStore>
  getQuote: GetLarkQuote
  signal: AbortSignal
  now?: () => number
}) {
  const { ownerOpenId, detail, merger, store, getQuote, signal, now = Date.now } = options
  const ownerScope = `owner-dm:${ownerOpenId}`

  async function preview(
    { chatId, replyToMessageId }: MergeMessage,
    text: string,
    readQuote: GetLarkQuote,
    confirmationScope = chatId,
  ) {
    let refs = pullRequestsIn(text)
    if (!refs.length && replyToMessageId) {
      const quote = await readQuote(chatId, replyToMessageId).catch(() => undefined)
      if (!quote || quote.includes('\n... (truncated)\n')) {
        return '暂时无法完整读取引用原文。请直接发「帮我合并」和 GitHub PR 链接。'
      }
      refs = pullRequestsIn(quote)
    }
    if (!refs.length) {
      return '请贴一个 GitHub PR 链接，或引用含有链接的消息再发「帮我合并」。'
    }
    if (refs.length > 1) {
      const choices = refs.slice(0, 5).map((pr) => `${pr.repository}#${pr.number}  ${prUrl(pr)}`)
      return [`找到 ${refs.length} 个 PR。请发「帮我合并」和其中一个 PR 链接。`, ...choices].join(
        '\n',
      )
    }

    const [ref] = refs
    const pr = await detail(ref.repository, ref.number).catch(() => null)
    if (!pr || !matchesReference(pr, ref)) {
      return `暂时读不到这个 PR。请检查链接和 GitHub 读取权限。\n${prUrl(ref)}`
    }

    const summary = [
      `合并预览 · ${pr.repository}#${pr.number}`,
      `标题 ${oneLine(pr.title)}`,
      prUrl(pr),
      `目标分支 ${oneLine(pr.baseRefName)} · 方式 ${merger.method}`,
      `待合并提交 ${pr.headRefOid}`,
      `CI ${pr.checks ?? '暂无检查数据'} · 评审 ${pr.reviewDecision ?? '暂无汇总结论'}`,
      `GitHub 合并状态 ${pr.mergeStateStatus}`,
    ].join('\n')
    const stopped = unavailable(pr)
    if (stopped) return `${summary}\n\n${stopped}`
    if (!merger.canMerge(pr.repository)) {
      return `${summary}\n\n这个仓库的合并权限未启用。`
    }
    if (!commitSha.test(pr.headRefOid) || !pr.baseRefName) {
      return `${summary}\n\nGitHub 暂时没有返回待合并提交或目标分支，请稍后重试。`
    }

    if (signal.aborted) return closing
    const { token } = store.create({
      chatId: confirmationScope,
      repository: pr.repository,
      number: pr.number,
      headSha: pr.headRefOid,
      baseRef: pr.baseRefName,
      method: merger.method,
      expiresAt: now() + confirmationTtlMs,
    })
    return `${summary}\n\n10 分钟内发送下面这行确认。\n确认合并 ${token}`
  }

  async function confirm(chatId: string, token: string | undefined) {
    if (!token) return '请复制预览里的完整确认指令。'
    if (signal.aborted) return closing
    const timestamp = now()
    const directClaim = store.claim(chatId, token, timestamp)
    const claim =
      directClaim.status === 'missing' ? store.claim(ownerScope, token, timestamp) : directClaim
    if (claim.status === 'missing') return '这条私聊没有对应的合并预览。请重新请求预览。'
    if (claim.status === 'expired') return '确认已过期。请重新请求合并预览。'
    if (claim.status === 'finished') return claim.message
    if (claim.status === 'processing') {
      return '这条确认已经进入处理。可以打开 GitHub 核对结果。'
    }

    const { request } = claim
    const finish = (message: string) => {
      const reply = `${message}\n${prUrl(request)}`
      store.finish(token, reply)
      return reply
    }
    if (!merger.canMerge(request.repository)) return finish('这个仓库的合并权限未启用。')
    const pr = await detail(request.repository, request.number).catch(() => null)
    if (!pr || !matchesReference(pr, request)) {
      return finish('无法重新读取 PR。请检查读取权限后重新请求预览。')
    }
    const stopped = unavailable(pr)
    if (stopped) return finish(stopped)
    if (
      pr.headRefOid !== request.headSha ||
      pr.baseRefName !== request.baseRef ||
      merger.method !== request.method
    ) {
      return finish(stale)
    }
    if (signal.aborted) return finish(closing)

    const result = await merger.merge(request)
    if (result.status === 'merged') {
      return finish(
        `已合并 ${request.repository}#${request.number}（${request.method}）\n合并提交 ${result.sha}`,
      )
    }
    if (result.status === 'stale') return finish(stale)
    if (result.status === 'unknown') {
      return finish('GitHub 合并结果暂时无法确认。请先打开 PR 核对状态。')
    }
    return finish(blocked[result.reason] ?? 'GitHub 拒绝了合并请求。请打开 PR 核对状态。')
  }

  return {
    answerDm: (message: MergeMessage, intent: MergeIntent) =>
      intent.kind === 'confirm'
        ? confirm(message.chatId, intent.token)
        : preview(message, intent.text, getQuote),
    previewFromGroup: (message: MergeMessage, text: string, getGroupQuote: GetLarkQuote) =>
      preview(message, text, getGroupQuote, ownerScope),
  }
}
