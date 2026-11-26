import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { hasFailingChecks, type listOpenPullRequests } from './github.ts'

type LarkMessage = Pick<NormalizedMessage, 'chatType' | 'senderId' | 'rawContentType' | 'content'>

interface HandlerOptions {
  ownerOpenId: string
  query: () => ReturnType<typeof listOpenPullRequests>
  onUnconfiguredOwner: (openId: string) => void
}

const help = '发「我的 PR」或 /prs 查看开放的 PR。\n发「CI 失败」或 /failed 只看检查失败的 PR。'
const openCommands = new Set(['我的 pr', '/prs'])
const failedCommands = new Set(['ci 失败', '/failed'])

export async function answerLarkMessage(message: LarkMessage, options: HandlerOptions) {
  if (message.chatType !== 'p2p' || message.rawContentType !== 'text') return

  if (!options.ownerOpenId) {
    if (message.senderId.startsWith('ou_')) options.onUnconfiguredOwner(message.senderId)
    return
  }
  if (message.senderId !== options.ownerOpenId) return

  const command = message.content.trim().toLowerCase()
  const failedOnly = failedCommands.has(command)
  if (!failedOnly && !openCommands.has(command)) return help

  let result: Awaited<ReturnType<HandlerOptions['query']>>
  try {
    result = await options.query()
  } catch {
    return 'GitHub 查询失败，请检查本地凭据和仓库权限，或稍后重试。'
  }

  const selected = failedOnly ? result.pullRequests.filter(hasFailingChecks) : result.pullRequests
  const label = failedOnly ? '检查失败的开放 PR' : '开放 PR'
  const rows = selected.map((pr) => {
    const draft = pr.draft ? ' · 草稿' : ''
    return `[${pr.checks ?? '无检查数据'}${draft}] ${pr.repository}#${pr.number} ${pr.title}\n${pr.url}`
  })
  return [`@${result.login} · ${selected.length} 个${label}`, ...rows].join('\n\n')
}
