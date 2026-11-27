import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  scope: text().primaryKey(),
  nativeId: text('native_id').notNull(),
  lastUsedAt: integer('last_used_at'),
  creationReason: text('creation_reason'),
  resetRequested: integer('reset_requested', { mode: 'boolean' }).notNull().default(false),
})

export const groupAnchors = sqliteTable(
  'group_anchors',
  {
    sequence: integer().primaryKey(),
    chatId: text('chat_id').notNull(),
    key: text('anchor_key').notNull(),
    sessionKey: text('session_key').notNull(),
    threadId: text('thread_id'),
  },
  (table) => [
    unique().on(table.chatId, table.key),
    index('group_anchors_by_chat').on(table.chatId, sql`"sequence" DESC`),
    index('group_anchors_by_topic').on(table.chatId, table.sessionKey),
  ],
)

export const groupRepositories = sqliteTable(
  'group_repositories',
  {
    scope: text().notNull(),
    nativeId: text('native_id').notNull(),
    repository: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.nativeId, table.repository] })],
)

export const privateGroupSessions = sqliteTable(
  'private_group_sessions',
  {
    scope: text().notNull(),
    nativeId: text('native_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.nativeId] })],
)
