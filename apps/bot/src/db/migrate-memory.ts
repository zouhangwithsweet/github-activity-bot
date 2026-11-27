import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

const migrationsFolder = fileURLToPath(new URL('../../drizzle/memory/', import.meta.url))
const journal = sqliteTable('__drizzle_memory_migrations', {
  name: text().primaryKey(),
})

export function migrateMemory(db: NodeSQLiteDatabase) {
  const migrations = readMigrationFiles({ migrationsFolder })
  // Take the write lock before reading the journal so concurrent starts apply each migration once.
  db.transaction(
    (tx) => {
      tx.run(sql`CREATE TABLE IF NOT EXISTS ${journal} (name TEXT PRIMARY KEY) STRICT`)
      const applied = new Set(
        tx
          .select()
          .from(journal)
          .all()
          .map(({ name }) => name),
      )
      for (const migration of migrations) {
        if (applied.has(migration.name)) continue
        for (const statement of migration.sql) {
          if (statement.trim()) tx.run(sql.raw(statement))
        }
        tx.insert(journal).values({ name: migration.name }).run()
      }
    },
    { behavior: 'immediate' },
  )
}
