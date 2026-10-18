import { DatabaseSync } from 'node:sqlite'

/**
 * A deliberately tiny abstraction over SQLite.
 *
 * The skeleton uses Node's built-in `node:sqlite`, which is experimental. The
 * whole point of this file is that swapping it for `better-sqlite3` (or anything
 * else) later touches this file and nothing else. See docs/adr/0001.
 *
 * Note: the parameter normalisation below is not decoration. `node:sqlite`
 * throws on `undefined` and on booleans, so callers in the repository layer are
 * free to pass either and we coerce here.
 */
export type SqlParam = string | number | bigint | boolean | null | undefined | Uint8Array

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult
  get<T>(...params: SqlParam[]): T | undefined
  all<T>(...params: SqlParam[]): T[]
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  /** Wraps `fn` in BEGIN/COMMIT. Not re-entrant; do not nest. */
  transaction<T>(fn: () => T): T
  close(): void
}

function normalize(params: SqlParam[]): Array<string | number | bigint | null | Uint8Array> {
  return params.map((param) => {
    if (param === undefined) return null
    if (typeof param === 'boolean') return param ? 1 : 0
    return param
  })
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

export function openDatabase(file: string): SqlDatabase {
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true })
  // WAL keeps reads from blocking the scan's writes; NORMAL is the usual pairing.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')

  let transactionDepth = 0
  // Preparing the same SQL repeatedly (once per row in a 10k-file scan) is pure
  // waste; node:sqlite statements are reusable, so cache them by SQL text.
  const statements = new Map<string, SqlStatement>()

  return {
    exec(sql: string): void {
      db.exec(sql)
    },

    prepare(sql: string): SqlStatement {
      const cached = statements.get(sql)
      if (cached) return cached
      const statement = db.prepare(sql)
      const wrapped: SqlStatement = {
        run(...params: SqlParam[]): SqlRunResult {
          const result = statement.run(...normalize(params))
          return {
            changes: toNumber(result.changes),
            lastInsertRowid: toNumber(result.lastInsertRowid)
          }
        },
        get<T>(...params: SqlParam[]): T | undefined {
          return statement.get(...normalize(params)) as T | undefined
        },
        all<T>(...params: SqlParam[]): T[] {
          return statement.all(...normalize(params)) as T[]
        }
      }
      statements.set(sql, wrapped)
      return wrapped
    },

    transaction<T>(fn: () => T): T {
      // SQLite has no nested transactions; an inner transaction joins the outer one.
      if (transactionDepth > 0) {
        transactionDepth += 1
        try {
          return fn()
        } finally {
          transactionDepth -= 1
        }
      }
      db.exec('BEGIN')
      transactionDepth += 1
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Rolling back a transaction that already aborted is not interesting.
        }
        throw error
      } finally {
        transactionDepth -= 1
      }
    },

    close(): void {
      db.close()
    }
  }
}
