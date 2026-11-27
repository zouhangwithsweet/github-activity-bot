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

type SessionCreationReason = 'first_use' | 'missing' | 'archived' | 'manual_reset'

export type LarkSessionEvent =
  | { action: 'opened' | 'replaced'; id: string; reason: SessionCreationReason }
  | { action: 'resumed'; id: string }

export async function openRememberedConversation<Answer>(
  scope: string,
  memory: Pick<LarkMemory, 'getSessionInfo' | 'saveSession' | 'touchSession'> | undefined,
  open: (resume?: string) => Promise<Conversation<Answer> & { id: string }>,
  onEvent?: (event: LarkSessionEvent) => void,
): Promise<Conversation<Answer>> {
  if (!memory) return open()
  const saved = memory.getSessionInfo(scope)
  const resume = saved?.resetRequested ? undefined : saved?.nativeId
  let reason: SessionCreationReason = saved?.resetRequested ? 'manual_reset' : 'first_use'
  let session: Conversation<Answer> & { id: string }
  try {
    session = await open(resume)
  } catch (error) {
    if (
      !resume ||
      !(error instanceof CodexAnswerError) ||
      error.diagnostic.stage !== 'session_start' ||
      (error.diagnostic.code !== 'session_not_found' &&
        error.diagnostic.code !== 'session_archived')
    ) {
      throw error
    }
    reason = error.diagnostic.code === 'session_archived' ? 'archived' : 'missing'
    session = await open()
  }

  try {
    if (resume === session.id) {
      onEvent?.({ action: 'resumed', id: session.id })
    } else {
      memory.saveSession(scope, session.id, reason)
      onEvent?.({ action: saved ? 'replaced' : 'opened', id: session.id, reason })
    }
  } catch (error) {
    await session.close().catch(() => undefined)
    throw error
  }

  return {
    answer: async (question) => {
      memory.touchSession(scope, session.id)
      return session.answer(question)
    },
    close: async () => session.close(),
  }
}

interface ChatConversation<Answer> {
  session?: Conversation<Answer>
  pending: Promise<unknown>
  idleTimer?: ReturnType<typeof setTimeout>
}

async function closeChatSession<Answer>(chat: ChatConversation<Answer>) {
  const session = chat.session
  chat.session = undefined
  await session?.close()
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

  async function enqueue<Result>(
    chatId: string,
    work: (slot: ChatConversation<Answer>) => Promise<Result>,
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
      return work(slot)
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

  function run<Result>(
    chatId: string,
    work: (answer: (question: string) => Promise<Answer>) => Promise<Result>,
  ) {
    return enqueue(chatId, (slot) =>
      work(async (question) => {
        try {
          slot.session ??= await open(chatId)
          return await slot.session.answer(question)
        } catch (error) {
          await closeChatSession(slot).catch(() => undefined)
          throw error
        }
      }),
    )
  }

  return {
    run,
    reset(chatId: string, requestReset: () => boolean) {
      return enqueue(chatId, async (slot) => {
        if (!requestReset()) return false
        await closeChatSession(slot)
        return true
      })
    },
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

export type LarkSessionCommand = 'status' | 'reset'

export function parseLarkSessionCommand(text: string): LarkSessionCommand | undefined {
  switch (text.trim().toLowerCase()) {
    case '/session':
      return 'status'
    case '/session reset':
      return 'reset'
  }
}

const sessionCreationLabels: Record<SessionCreationReason, string> = {
  first_use: '首次使用',
  missing: '原会话缺失',
  archived: '原会话已归档',
  manual_reset: '手动重置',
}

export function larkSessionStatus(memory: Pick<LarkMemory, 'getSessionInfo'>, scope: string) {
  const session = memory.getSessionInfo(scope)
  if (!session) return '当前聊天还没有 Codex 会话。'
  if (session.resetRequested) return '当前会话已重置。下次问答时会开启新会话。'
  const lines = ['当前聊天已绑定 Codex 会话。']
  if (scope.startsWith('dm:')) lines.push(`Codex ID：${session.nativeId}`)
  if (session.lastUsedAt !== null) {
    lines.push(`上次使用（UTC）：${new Date(session.lastUsedAt).toISOString()}`)
  }
  if (session.creationReason && Object.hasOwn(sessionCreationLabels, session.creationReason)) {
    lines.push(
      `创建原因：${sessionCreationLabels[session.creationReason as SessionCreationReason]}`,
    )
  }
  return lines.join('\n')
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
  sessionCommand?: (command: LarkSessionCommand, chatId: string) => Promise<string>
  onUnconfiguredOwner: (openId: string) => void
  onEvent?: (event: ConversationEvent) => void
}

const help =
  '发 /prs 查看开放的 PR，/failed 查看 CI 失败的 PR，或 /session 查看当前会话。也可以直接问「我有哪些 PR 卡在 CI？」。'
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
  const sessionCommand = parseLarkSessionCommand(question)
  if (sessionCommand && options.sessionCommand) {
    return options.sessionCommand(sessionCommand, message.chatId)
  }
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
