import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
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

export interface LarkSessionInfo {
  nativeId: string
  lastUsedAt: number | null
  creationReason: string | null
  resetRequested: boolean
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
      getSessionInfo(scope: string): LarkSessionInfo | undefined {
        return db
          .select({
            nativeId: sessions.nativeId,
            lastUsedAt: sessions.lastUsedAt,
            creationReason: sessions.creationReason,
            resetRequested: sessions.resetRequested,
          })
          .from(sessions)
          .where(eq(sessions.scope, scope))
          .get()
      },
      saveSession(scope: string, nativeId: string, creationReason?: string) {
        const details = {
          nativeId,
          lastUsedAt: Date.now(),
          creationReason: creationReason ?? null,
          resetRequested: false,
        }
        db.insert(sessions)
          .values({ scope, ...details })
          .onConflictDoUpdate({ target: sessions.scope, set: details })
          .run()
      },
      touchSession(scope: string, nativeId: string) {
        db.update(sessions)
          .set({ lastUsedAt: Date.now() })
          .where(
            and(
              eq(sessions.scope, scope),
              eq(sessions.nativeId, nativeId),
              eq(sessions.resetRequested, false),
            ),
          )
          .run()
      },
      requestSessionReset(scope: string) {
        const { changes } = db
          .update(sessions)
          .set({ resetRequested: true })
          .where(eq(sessions.scope, scope))
          .run()
        return changes > 0
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
      getGroupAnchor(chatId: string, key: string): LarkGroupAnchor | undefined {
        const anchor = db
          .select({
            key: groupAnchors.key,
            sessionKey: groupAnchors.sessionKey,
            threadId: groupAnchors.threadId,
          })
          .from(groupAnchors)
          .where(and(eq(groupAnchors.chatId, chatId), eq(groupAnchors.key, key)))
          .get()
        if (!anchor) return

        const threadId =
          anchor.threadId ??
          db
            .select({ threadId: groupAnchors.threadId })
            .from(groupAnchors)
            .where(
              and(
                eq(groupAnchors.chatId, chatId),
                eq(groupAnchors.sessionKey, anchor.sessionKey),
                isNotNull(groupAnchors.threadId),
              ),
            )
            .orderBy(desc(groupAnchors.sequence))
            .get()?.threadId
        return { key, sessionKey: anchor.sessionKey, threadId: threadId ?? undefined }
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
      getGroupRepositories(scope: string, nativeId: string): string[] {
        return db
          .select({ repository: groupRepositories.repository })
          .from(groupRepositories)
          .where(and(eq(groupRepositories.scope, scope), eq(groupRepositories.nativeId, nativeId)))
          .orderBy(groupRepositories.repository)
          .all()
          .map(({ repository }) => repository)
      },
      rememberGroupRepository(scope: string, nativeId: string, repository: string) {
        db.insert(groupRepositories)
          .values({ scope, nativeId, repository: repository.toLowerCase() })
          .onConflictDoNothing()
          .run()
      },
      isGroupPrivate(scope: string, nativeId: string): boolean {
        return Boolean(
          db
            .select({ scope: privateGroupSessions.scope })
            .from(privateGroupSessions)
            .where(
              and(
                eq(privateGroupSessions.scope, scope),
                eq(privateGroupSessions.nativeId, nativeId),
              ),
            )
            .get(),
        )
      },
      markGroupPrivate(scope: string, nativeId: string) {
        db.insert(privateGroupSessions).values({ scope, nativeId }).onConflictDoNothing().run()
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
