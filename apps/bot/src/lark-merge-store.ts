import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { MergeMethod } from './github-merge.ts'

export interface LarkMergeRequest {
  chatId: string
  repository: string
  number: number
  headSha: string
  baseRef: string
  method: MergeMethod
  expiresAt: number
}

type LarkMergeClaim =
  | { status: 'claimed'; request: LarkMergeRequest }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'processing' }
  | { status: 'finished'; message: string }

export function openLarkMergeStore(databasePath: string) {
  const database = new DatabaseSync(join(dirname(databasePath), 'merge.sqlite'), { timeout: 5_000 })
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS lark_merge_requests (
        token TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('merge', 'squash', 'rebase')),
        expires_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'finished')),
        message TEXT,
        CHECK (status <> 'finished' OR message IS NOT NULL)
      ) STRICT;
    `)

    const insert = database.prepare(`
      INSERT INTO lark_merge_requests (
        token, chat_id, repository, pr_number, head_sha, base_ref, method, expires_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (token) DO NOTHING
    `)
    const take = database.prepare(`
      UPDATE lark_merge_requests SET status = 'processing'
      WHERE token = ? AND chat_id = ? AND status = 'pending' AND expires_at_ms > ?
      RETURNING chat_id AS chatId, repository, pr_number AS number, head_sha AS headSha,
        base_ref AS baseRef, method, expires_at_ms AS expiresAt
    `)
    const read = database.prepare(`
      SELECT status, message FROM lark_merge_requests WHERE token = ? AND chat_id = ?
    `)
    const finish = database.prepare(`
      UPDATE lark_merge_requests SET status = 'finished', message = ?
      WHERE token = ? AND status = 'processing'
    `)

    function claimRequest(chatId: string, token: string, now: number): LarkMergeClaim {
      const request = take.get(token, chatId, now) as LarkMergeRequest | undefined
      if (request) return { status: 'claimed', request: { ...request } }

      const previous = read.get(token, chatId)
      if (!previous) return { status: 'missing' }
      if (previous.status === 'finished') {
        return { status: 'finished', message: previous.message as string }
      }
      if (previous.status === 'processing') return { status: 'processing' }
      return { status: 'expired' }
    }

    return {
      create(input: LarkMergeRequest): { token: string } {
        const { chatId, repository, number, headSha, baseRef, method, expiresAt } = input
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const token = randomBytes(6).toString('hex').toUpperCase()
          const saved = insert.run(
            token,
            chatId,
            repository,
            number,
            headSha,
            baseRef,
            method,
            expiresAt,
          )
          if (saved.changes) return { token }
        }
        throw new Error('Could not allocate a Lark merge confirmation token.')
      },
      claim(chatId: string, token: string, now: number): LarkMergeClaim {
        database.exec('BEGIN IMMEDIATE')
        try {
          const result = claimRequest(chatId, token.trim().toUpperCase(), now)
          database.exec('COMMIT')
          return result
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      },
      finish(token: string, message: string): void {
        finish.run(message, token.trim().toUpperCase())
      },
      close(): void {
        if (database.isOpen) database.close()
      },
    }
  } catch (error) {
    database.close()
    throw error
  }
}
