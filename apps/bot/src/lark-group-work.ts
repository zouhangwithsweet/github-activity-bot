import { CodexAnswerError, type GitHubConversationTools } from './agent.ts'
import type { PublicRepositoryQuery } from './github.ts'
import type { LarkGroupTurn } from './lark-group.ts'
import type { LarkMemory } from './lark-memory.ts'
import { parseLarkMergeIntent, type createLarkMergeFlow } from './lark-merge.ts'
import { resolveLarkQuotePrompt, type GetLarkQuote } from './lark-quote.ts'

type GroupAccessMemory = Pick<
  LarkMemory,
  'getGroupRepositories' | 'rememberGroupRepository' | 'isGroupPrivate' | 'markGroupPrivate'
>

export function trackGroupGitHubAccess(
  tools: GitHubConversationTools,
  isPublicRepository: PublicRepositoryQuery,
  state?: { scope: string; memory: GroupAccessMemory },
) {
  const repositories = new Set(state?.memory.getGroupRepositories(state.scope))
  let privateConversation = state?.memory.isGroupPrivate(state.scope) ?? false

  function rememberRepository(repository: string) {
    const name = repository.toLowerCase()
    if (repositories.has(name)) return
    if (state) state.memory.rememberGroupRepository(state.scope, name)
    repositories.add(name)
  }

  function markPrivate() {
    if (privateConversation) return
    if (state) state.memory.markGroupPrivate(state.scope)
    privateConversation = true
  }

  function trackQuery<Arguments extends unknown[], Result extends { repository: string } | null>(
    query: (repository: string, ...args: Arguments) => Promise<Result>,
  ) {
    return async (repository: string, ...args: Arguments) => {
      rememberRepository(repository)
      const result = await query(repository, ...args)
      if (result) rememberRepository(result.repository)
      return result
    }
  }

  return {
    tools: {
      list: () => {
        markPrivate()
        return tools.list()
      },
      detail: trackQuery(tools.detail),
      checks: trackQuery(tools.checks),
      reviews: trackQuery(tools.reviews),
    },
    async canReplyInGroup() {
      if (privateConversation) return false
      const visibility = await Promise.all(
        Array.from(repositories, (repo) => isPublicRepository(repo).catch(() => false)),
      )
      // A later turn can reuse tool results already present in this conversation.
      if (visibility.includes(false)) markPrivate()
      return !privateConversation
    },
  }
}

export interface LarkGroupAnswer {
  text: string
  canReplyInGroup: boolean
}

interface GroupWorkOptions {
  getQuote: GetLarkQuote
  previewMerge?: ReturnType<typeof createLarkMergeFlow>['previewFromGroup']
  run: (
    sessionKey: string,
    work: (answer: (question: string) => Promise<LarkGroupAnswer>) => Promise<LarkGroupAnswer>,
  ) => Promise<LarkGroupAnswer>
  replyInGroup: (text: string) => Promise<void>
  sendPrivately: (text: string) => Promise<void>
  reportFailure: (
    step: 'acknowledge' | 'answer' | 'merge_preview' | 'private_delivery',
    error: unknown,
  ) => void
  signal?: AbortSignal
}

export async function processLarkGroupTurn(turn: LarkGroupTurn, options: GroupWorkOptions) {
  options.signal?.throwIfAborted()
  const merge = parseLarkMergeIntent(turn.question)
  if (merge?.kind === 'confirm') {
    await options.replyInGroup('请在 Bot 私聊里确认合并。')
    return
  }
  if (merge && (!turn.mentionedBot || !options.previewMerge)) {
    await options.replyInGroup(
      turn.mentionedBot ? '请在 Bot 私聊里发起合并。' : '请 @ 我发起合并预览。',
    )
    return
  }
  const acknowledgement = options
    .replyInGroup('好的，收到！')
    .catch((error: unknown) => options.reportFailure('acknowledge', error))
  if (!turn.question) {
    await acknowledgement
    return
  }

  let answer: LarkGroupAnswer
  try {
    if (merge && options.previewMerge) {
      answer = {
        text: await options.previewMerge(turn, merge.text, options.getQuote),
        canReplyInGroup: false,
      }
    } else {
      answer = await options.run(turn.sessionKey, async (answer) => {
        const prompt = await resolveLarkQuotePrompt(turn, options.getQuote)
        options.signal?.throwIfAborted()
        if (prompt.kind === 'ready') return answer(prompt.question)
        return {
          text: '我读不到引用的消息。请回复我并贴上 GitHub PR 链接或编号。',
          canReplyInGroup: true,
        }
      })
    }
  } catch (error) {
    options.reportFailure(merge ? 'merge_preview' : 'answer', error)
    const timedOut =
      error instanceof CodexAnswerError &&
      error.diagnostic.stage === 'turn' &&
      error.diagnostic.code === 'timeout'
    answer = {
      canReplyInGroup: true,
      text: merge
        ? '合并预览暂时无法完成，请在私聊里重试。'
        : timedOut
          ? '这次查询超时了。可以先问 CI 和评审，再追问主要改动。'
          : '这次 GitHub 查询暂时失败了，可以回复我重试。',
    }
  }
  await acknowledgement
  options.signal?.throwIfAborted()

  if (answer.canReplyInGroup) {
    await options.replyInGroup(answer.text)
    return
  }
  if (!merge) {
    await options.replyInGroup('这条查询涉及个人或受限的 GitHub 数据，请私聊我查询。')
    return
  }

  let status = '已在私聊回复你的合并请求。'
  try {
    await options.sendPrivately(answer.text)
  } catch (error) {
    options.reportFailure('private_delivery', error)
    status = '私聊发送失败，请在私聊里重试合并预览。'
  }
  options.signal?.throwIfAborted()
  await options.replyInGroup(status)
}
