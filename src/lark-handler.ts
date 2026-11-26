import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { hasFailingChecks, type listOpenPullRequests } from './github.ts'

type LarkMessage = Pick<NormalizedMessage, 'chatType' | 'senderId' | 'rawContentType' | 'content'>

interface HandlerOptions {
  ownerOpenId: string
  query: () => ReturnType<typeof listOpenPullRequests>
  answer: (question: string) => Promise<string>
  onUnconfiguredOwner: (openId: string) => void
}

const help =
  '发 /prs 查看开放的 PR，或发 /failed 查看 CI 失败的 PR。也可以直接问「我有哪些 PR 卡在 CI？」。'
const openCommands = new Set(['我的 pr', '/prs'])
const failedCommands = new Set(['ci 失败', '/failed'])

export async function answerLarkMessage(message: LarkMessage, options: HandlerOptions) {
  if (message.chatType !== 'p2p' || message.rawContentType !== 'text') return

  if (!options.ownerOpenId) {
    if (message.senderId.startsWith('ou_')) options.onUnconfiguredOwner(message.senderId)
    return
  }
  if (message.senderId !== options.ownerOpenId) return

  const question = message.content.trim()
  if (!question) return
  const command = question.toLowerCase()
  const failedOnly = failedCommands.has(command)
  if (!failedOnly && !openCommands.has(command)) {
    if (command.startsWith('/')) return help
    try {
      return await options.answer(question)
    } catch {
      return 'Codex 暂时无法完成问答。可以先用 /prs 或 /failed 查询。'
    }
  }

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
