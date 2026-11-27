import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { and, desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-sqlite'
import {
  groupAnchors,
  groupRepositories,
  privateGroupSessions,
  sessions,
} from './db/memory-schema.ts'
import { migrateMemory } from './db/migrate-memory.ts'

export interface LarkGroupAnchor {
  key: string
  sessionKey: string
  threadId?: string
}

const maxGroupAnchors = 4_096

export function openLarkMemory(stateDir: string, identity: { appId: string; ownerOpenId: string }) {
  const identityKey = createHash('sha256')
    .update(JSON.stringify([identity.appId, identity.ownerOpenId]))
    .digest('hex')
  const directory = resolve(stateDir, identityKey)
  const cwd = join(directory, 'codex')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })

  const databasePath = join(directory, 'memory.sqlite')
  const database = new DatabaseSync(databasePath, { timeout: 5_000 })
  try {
    database.exec('PRAGMA journal_mode = WAL')
    const db = drizzle({ client: database })
    migrateMemory(db)

    return {
      cwd,
      databasePath,
      getSession(scope: string): string | undefined {
        return db
          .select({ nativeId: sessions.nativeId })
          .from(sessions)
          .where(eq(sessions.scope, scope))
          .get()?.nativeId
      },
      saveSession(scope: string, nativeId: string) {
        db.insert(sessions)
          .values({ scope, nativeId })
          .onConflictDoUpdate({ target: sessions.scope, set: { nativeId } })
          .run()
      },
      forgetSession(scope: string, nativeId: string) {
        db.delete(sessions)
          .where(and(eq(sessions.scope, scope), eq(sessions.nativeId, nativeId)))
          .run()
      },
      getGroupAnchors(chatId: string): LarkGroupAnchor[] {
        return db
          .select({
            key: groupAnchors.key,
            sessionKey: groupAnchors.sessionKey,
            threadId: groupAnchors.threadId,
          })
          .from(groupAnchors)
          .where(eq(groupAnchors.chatId, chatId))
          .orderBy(desc(groupAnchors.sequence))
          .limit(maxGroupAnchors)
          .all()
          .reverse()
          .map(({ threadId, ...anchor }) => (threadId ? { ...anchor, threadId } : anchor))
      },
      saveGroupAnchor(chatId: string, anchor: LarkGroupAnchor) {
        const { key, sessionKey, threadId = null } = anchor
        db.insert(groupAnchors)
          .values({ chatId, key, sessionKey, threadId })
          .onConflictDoUpdate({
            target: [groupAnchors.chatId, groupAnchors.key],
            set: { sequence: sql`excluded.sequence`, sessionKey, threadId },
          })
          .run()
      },
      getGroupRepositories(scope: string): string[] {
        return db
          .select({ repository: groupRepositories.repository })
          .from(groupRepositories)
          .where(eq(groupRepositories.scope, scope))
          .orderBy(groupRepositories.repository)
          .all()
          .map(({ repository }) => repository)
      },
      rememberGroupRepository(scope: string, repository: string) {
        db.insert(groupRepositories)
          .values({ scope, repository: repository.toLowerCase() })
          .onConflictDoNothing()
          .run()
      },
      isGroupPrivate(scope: string): boolean {
        return Boolean(
          db
            .select({ scope: privateGroupSessions.scope })
            .from(privateGroupSessions)
            .where(eq(privateGroupSessions.scope, scope))
            .get(),
        )
      },
      markGroupPrivate(scope: string) {
        db.insert(privateGroupSessions).values({ scope }).onConflictDoNothing().run()
      },
      close() {
        if (database.isOpen) database.close()
      },
    }
  } catch (error) {
    database.close()
    throw error
  }
}

export type LarkMemory = ReturnType<typeof openLarkMemory>
