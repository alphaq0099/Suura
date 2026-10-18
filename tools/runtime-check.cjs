/**
 * Verifies the runtime bets this skeleton makes, *inside Electron* rather than in
 * plain Node, and in the CommonJS form the main process bundle actually uses.
 *
 *   npm run runtime:check
 *
 * Two assumptions are worth checking on every Electron upgrade:
 *  1. `node:sqlite` exists and has FTS5 (the whole library DB depends on it),
 *  2. `music-metadata` can be loaded from CommonJS (it is ESM-only, so this
 *     relies on Node's require(esm) via its "module-sync" export condition).
 */
const sqlite = require('node:sqlite')

const db = new sqlite.DatabaseSync(':memory:')
db.exec('CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist)')
db.prepare('INSERT INTO tracks_fts (title, artist) VALUES (?, ?)').run('Test Tone', 'Smoke Artist')
const hit = db.prepare("SELECT title FROM tracks_fts WHERE tracks_fts MATCH '\"Tone\"*'").get()

console.log('electron version :', process.versions.electron)
console.log('node version     :', process.versions.node)
console.log('node:sqlite      :', typeof sqlite.DatabaseSync === 'function' ? 'ok' : 'MISSING')
console.log('sqlite FTS5      :', hit && hit.title === 'Test Tone' ? 'ok' : 'UNAVAILABLE')

try {
  const metadata = require('music-metadata')
  console.log('music-metadata   :', typeof metadata.parseFile === 'function' ? 'ok (require)' : 'unexpected export shape')
} catch (error) {
  console.log('music-metadata   : FAILED via require ->', error.message)
  process.exitCode = 1
}
