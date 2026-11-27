import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { CodexAnswerError } from './agent.ts'
import { hasFailingChecks, type PullRequestQuery } from './github.ts'
import type { LarkMemory } from './lark-memory.ts'
import { parseLarkMergeIntent, type createLarkMergeFlow } from './lark-merge.ts'
import { isLarkTextMessage, resolveLarkQuotePrompt, type GetLarkQuote } from './lark-quote.ts'
import { parsePullRequestReview, type PullRequestReviewRequest } from './pull-request-review.ts'

type LarkMessage = Pick<
  NormalizedMessage,
  'chatId' | 'chatType' | 'senderId' | 'rawContentType' | 'content' | 'replyToMessageId'
>

interface Conversation<Answer> {
  answer(question: string): Promise<Answer>
  close(): Promise<void>
}

export async function openRememberedConversation<Answer>(
  scope: string,
  memory: Pick<LarkMemory, 'getSession' | 'saveSession' | 'forgetSession'> | undefined,
  open: (resume?: string) => Promise<Conversation<Answer> & { id: string }>,
): Promise<Conversation<Answer>> {
  if (!memory) return open()
  let savedId = memory.getSession(scope)
  let session: Conversation<Answer> & { id: string }
  try {
    session = await open(savedId)
  } catch (error) {
    if (
      !savedId ||
      !(error instanceof CodexAnswerError) ||
      error.diagnostic.stage !== 'session_start' ||
      error.diagnostic.code !== 'session_not_found'
    ) {
      throw error
    }
    memory.forgetSession(scope, savedId)
    savedId = undefined
    session = await open()
  }

  return {
    answer: async (question) => {
      const answer = await session.answer(question)
      if (savedId !== session.id) {
        memory.saveSession(scope, session.id)
        savedId = session.id
      }
      return answer
    },
    close: async () => session.close(),
  }
}

interface ChatConversation<Answer> {
  session?: Conversation<Answer>
  pending: Promise<unknown>
  idleTimer?: ReturnType<typeof setTimeout>
}

interface LarkProgress {
  show(): Promise<string>
  hide(reactionId: string): Promise<void>
  acknowledge(): Promise<void>
  onError(operation: 'show' | 'hide' | 'acknowledge'): void
}

export function startLarkProgress(progress: LarkProgress, delayMs = 400) {
  let finished = false
  let reaction: Promise<string | undefined> | undefined
  const timer = setTimeout(() => {
    reaction = progress.show().catch(async () => {
      progress.onError('show')
      if (!finished) {
        await progress.acknowledge().catch(() => progress.onError('acknowledge'))
      }
      return undefined
    })
  }, delayMs)

  return async () => {
    finished = true
    clearTimeout(timer)
    const reactionId = await reaction
    if (reactionId) await progress.hide(reactionId).catch(() => progress.onError('hide'))
  }
}

export function createLarkConversations<Answer>(
  open: (chatId: string) => Promise<Conversation<Answer>>,
  idleMs?: number,
) {
  const chats = new Map<string, ChatConversation<Answer>>()
  let closing: Promise<void> | undefined

  async function run<Result>(
    chatId: string,
    work: (answer: (question: string) => Promise<Answer>) => Promise<Result>,
  ) {
    if (closing) throw new Error('Lark conversations are closing.')
    let chat = chats.get(chatId)
    if (!chat) {
      chat = { pending: Promise.resolve() }
      chats.set(chatId, chat)
    }
    clearTimeout(chat.idleTimer)
    const slot = chat

    const turn = slot.pending.then(() => {
      if (closing) throw new Error('Lark conversations are closing.')
      return work(async (question) => {
        try {
          slot.session ??= await open(chatId)
          return await slot.session.answer(question)
        } catch (error) {
          const session = slot.session
          slot.session = undefined
          await session?.close().catch(() => undefined)
          throw error
        }
      })
    })
    const pending = turn.catch(() => undefined)
    slot.pending = pending

    if (idleMs !== undefined) {
      void pending.then(() => {
        if (closing || slot.pending !== pending) return
        slot.idleTimer = setTimeout(() => {
          chats.delete(chatId)
          void slot.session?.close().catch(() => undefined)
        }, idleMs).unref()
      })
    }
    return turn
  }

  return {
    run,
    async answer(this: void, question: string, chatId: string) {
      return run(chatId, (answer) => answer(question))
    },
    close() {
      closing ??= Promise.all(
        Array.from(chats.values(), async (chat) => {
          clearTimeout(chat.idleTimer)
          await chat.pending
          await chat.session?.close()
        }),
      ).then(() => {
        chats.clear()
      })
      return closing
    },
  }
}

type ConversationEvent =
  | { event: 'received'; text: string; source?: 'merge' | 'review' }
  | { event: 'processing_failed'; source: 'codex'; error: unknown }
  | { event: 'processing_failed'; source: 'github' | 'merge' | 'review' }

interface HandlerOptions {
  ownerOpenId: string
  query: PullRequestQuery
  run: ReturnType<typeof createLarkConversations<string>>['run']
  getQuote: GetLarkQuote
  merge?: ReturnType<typeof createLarkMergeFlow>['answerDm']
  review?: (request: PullRequestReviewRequest | 'invalid') => Promise<string>
  onUnconfiguredOwner: (openId: string) => void
  onEvent?: (event: ConversationEvent) => void
}

const help =
  '发 /prs 查看开放的 PR，或发 /failed 查看 CI 失败的 PR。也可以直接问「我有哪些 PR 卡在 CI？」。'
const openCommands = new Set(['我的 pr', '/prs'])
const failedCommands = new Set(['ci 失败', '/failed'])

export async function answerLarkMessage(message: LarkMessage, options: HandlerOptions) {
  if (message.chatType !== 'p2p') return
  if (!isLarkTextMessage(message.rawContentType)) return

  if (!options.ownerOpenId) {
    if (message.senderId.startsWith('ou_')) options.onUnconfiguredOwner(message.senderId)
    return
  }
  if (message.senderId !== options.ownerOpenId) return

  const question = message.content.trim()
  if (!question) return
  const mergeIntent = options.merge && parseLarkMergeIntent(question)
  if (mergeIntent && options.merge) {
    options.onEvent?.({ event: 'received', text: mergeIntent.kind, source: 'merge' })
    try {
      return await options.merge(message, mergeIntent)
    } catch {
      options.onEvent?.({ event: 'processing_failed', source: 'merge' })
      return '合并流程暂时无法完成。如果已发出确认，请先在 GitHub 核对状态。'
    }
  }

  const reviewRequest = options.review && parsePullRequestReview(question)
  if (reviewRequest && options.review) {
    options.onEvent?.({ event: 'received', text: 'review', source: 'review' })
    try {
      return await options.review(reviewRequest)
    } catch {
      options.onEvent?.({ event: 'processing_failed', source: 'review' })
      return '暂时无法完成 PR 改动评审，请稍后重试。'
    }
  }

  options.onEvent?.({ event: 'received', text: question })
  const command = question.toLowerCase()
  const failedOnly = failedCommands.has(command)
  if (!failedOnly && !openCommands.has(command)) {
    if (command.startsWith('/')) return help
    try {
      return await options.run(message.chatId, async (answer) => {
        const prompt = await resolveLarkQuotePrompt(
          { chatId: message.chatId, question, quotedMessageId: message.replyToMessageId },
          options.getQuote,
        )
        if (prompt.kind === 'ready') return answer(prompt.question)
        return '我读不到引用的消息。请贴上 GitHub PR 链接或 owner/repo#编号。'
      })
    } catch (error) {
      options.onEvent?.({ event: 'processing_failed', source: 'codex', error })
      if (
        error instanceof CodexAnswerError &&
        error.diagnostic.stage === 'turn' &&
        error.diagnostic.code === 'timeout'
      ) {
        return '这次问答超时了。可以先问 PR 的 CI 和评审，再追问主要改动。'
      }
      return 'Codex 暂时无法完成问答。可以先用 /prs 或 /failed 查询。'
    }
  }

  let result: Awaited<ReturnType<HandlerOptions['query']>>
  try {
    result = await options.query()
  } catch {
    options.onEvent?.({ event: 'processing_failed', source: 'github' })
    return 'GitHub 查询失败，请检查本地凭据和仓库权限，或稍后重试。'
  }

  const selected = failedOnly ? result.pullRequests.filter(hasFailingChecks) : result.pullRequests
  const label = failedOnly ? '检查失败的开放 PR' : '开放 PR'
  const rows = selected.map((pr) => {
    const draft = pr.draft ? ' · 草稿' : ''
    return `[${pr.checks ?? '无检查数据'}${draft}] ${pr.repository}#${pr.number} ${pr.title}\n${pr.url}`
  })
  const header = `@${result.login} · 当前凭据可见 ${selected.length} 个${label}`
  const unavailable = result.unavailableRepositories
  const coverage = unavailable.length
    ? [`结果不完整。无法读取 ${unavailable.join('、')} 的 PR。`]
    : []
  return [header, ...coverage, ...rows].join('\n\n')
}
