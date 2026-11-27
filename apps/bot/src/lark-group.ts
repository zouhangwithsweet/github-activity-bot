import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { LarkMemory } from './lark-memory.ts'
import { isLarkTextMessage, readableLarkText } from './lark-quote.ts'

type GroupMessage = Pick<
  NormalizedMessage,
  | 'chatId'
  | 'chatType'
  | 'content'
  | 'mentionedBot'
  | 'messageId'
  | 'rawContentType'
  | 'replyToMessageId'
  | 'rootId'
  | 'senderId'
  | 'threadId'
>

export interface LarkGroupTurn {
  chatId: string
  sessionKey: string
  messageId: string
  question: string
  mentionedBot: boolean
  threadId?: string
  replyToMessageId?: string
  quotedMessageId?: string
  inferIntent?: boolean
}

interface GroupTopic {
  sessionKey: string
  threadId?: string
}

const maxAnchors = 4_096
const inferredQuestion =
  '请根据引用内容做只读排查。先概括引用消息的请求。能明确识别 GitHub PR 时，查询当前 CI 和评审状态。建议下一步，或指出还缺少哪些信息。'

export function createLarkGroupRouter(options: {
  ownerOpenId: string
  allowedChatIds: Iterable<string>
  memory?: Pick<LarkMemory, 'getGroupAnchors' | 'saveGroupAnchor'>
}) {
  const allowedChats = new Set(options.allowedChatIds)
  const anchors = new Map<string, GroupTopic>()
  const anchorKey = (chatId: string, kind: 'message' | 'thread', id: string) =>
    `${chatId}:${kind}:${id}`

  function remember(key: string, topic: GroupTopic) {
    anchors.delete(key)
    anchors.set(key, topic)
    if (anchors.size > maxAnchors) {
      const oldest = anchors.keys().next()
      if (!oldest.done) anchors.delete(oldest.value)
    }
  }

  function saveAnchor(chatId: string, key: string, topic: GroupTopic) {
    options.memory?.saveGroupAnchor(chatId, { key, ...topic })
    remember(key, topic)
  }

  function rememberThread(chatId: string, threadId: string, topic: GroupTopic) {
    topic.threadId = threadId
    saveAnchor(chatId, anchorKey(chatId, 'thread', threadId), topic)
  }

  for (const chatId of allowedChats) {
    const topics = new Map<string, GroupTopic>()
    for (const entry of options.memory?.getGroupAnchors(chatId) ?? []) {
      const topic = topics.get(entry.sessionKey) ?? { sessionKey: entry.sessionKey }
      topic.threadId ??= entry.threadId
      topics.set(entry.sessionKey, topic)
      remember(entry.key, topic)
    }
  }

  return {
    route(message: GroupMessage): LarkGroupTurn | undefined {
      if (
        message.chatType !== 'group' ||
        !options.ownerOpenId ||
        message.senderId !== options.ownerOpenId ||
        !allowedChats.has(message.chatId) ||
        !isLarkTextMessage(message.rawContentType)
      )
        return

      const { chatId, messageId, mentionedBot, threadId, rootId, replyToMessageId } = message
      const authoredNote = readableLarkText(message.content)
      const inferIntent = !authoredNote && mentionedBot && Boolean(replyToMessageId)
      if (!authoredNote && !mentionedBot) return
      const findMessage = (id: string | undefined) => {
        const found = id ? anchors.get(anchorKey(chatId, 'message', id)) : undefined
        if (found?.threadId && threadId && found.threadId !== threadId) return
        return found
      }

      const parent = findMessage(replyToMessageId)
      const thread = threadId ? anchors.get(anchorKey(chatId, 'thread', threadId)) : undefined
      const existingTopic = thread ?? parent ?? findMessage(rootId)
      if (!existingTopic && !mentionedBot) return

      const topic = existingTopic ?? { sessionKey: `group:${chatId}:${threadId ?? messageId}` }
      saveAnchor(chatId, anchorKey(chatId, 'message', messageId), topic)
      if (threadId) rememberThread(chatId, threadId, topic)

      return {
        chatId,
        sessionKey: topic.sessionKey,
        messageId,
        question: authoredNote ?? (inferIntent ? inferredQuestion : ''),
        mentionedBot,
        threadId,
        replyToMessageId,
        // Authored follow-ups can use session history. A bare mention needs the actual quote.
        quotedMessageId:
          replyToMessageId && (inferIntent || parent !== topic) ? replyToMessageId : undefined,
        inferIntent: inferIntent || undefined,
      }
    },
    recordReply(turn: LarkGroupTurn, replyMessageId: string, threadId?: string) {
      const topic = anchors.get(anchorKey(turn.chatId, 'message', turn.messageId))
      if (topic?.sessionKey !== turn.sessionKey) return
      saveAnchor(turn.chatId, anchorKey(turn.chatId, 'message', replyMessageId), topic)
      if (threadId && (!topic.threadId || topic.threadId === threadId)) {
        rememberThread(turn.chatId, threadId, topic)
      }
    },
  }
}
