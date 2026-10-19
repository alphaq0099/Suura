import type { SqlDatabase } from './driver'

export interface Migration {
  version: number
  name: string
  up: (db: SqlDatabase) => void
}

/**
 * Append-only list. Never edit a shipped migration: add a new one, because users
 * will already have the old `user_version` recorded in their database file.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial library schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE tracks (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          source_kind    TEXT    NOT NULL DEFAULT 'local',
          source_id      TEXT,
          content_key    TEXT    NOT NULL,
          title          TEXT    NOT NULL,
          artist         TEXT,
          album_artist   TEXT,
          album          TEXT,
          track_no       INTEGER,
          disc_no        INTEGER,
          year           INTEGER,
          genre          TEXT,
          duration_ms    INTEGER,
          codec          TEXT,
          bitrate_kbps   INTEGER,
          sample_rate    INTEGER,
          channels       INTEGER,
          file_size      INTEGER,
          file_mtime_ms  INTEGER,
          file_path      TEXT,
          added_at       INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          play_count     INTEGER NOT NULL DEFAULT 0,
          last_played_at INTEGER
        );

        -- Identity is the path for local files and the video id for YouTube, so a
        -- single unique key works for both sources.
        CREATE UNIQUE INDEX idx_tracks_content_key ON tracks(content_key);
        CREATE INDEX idx_tracks_artist     ON tracks(artist COLLATE NOCASE);
        CREATE INDEX idx_tracks_album      ON tracks(album COLLATE NOCASE);
        CREATE INDEX idx_tracks_file_path  ON tracks(file_path);
        CREATE INDEX idx_tracks_source     ON tracks(source_kind, source_id);

        -- External-content FTS5: the index stores no copy of the text, so the
        -- triggers below are what keep it in sync. Search lands in M1.
        CREATE VIRTUAL TABLE tracks_fts USING fts5(
          title,
          artist,
          album,
          album_artist,
          genre,
          content='tracks',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER tracks_fts_insert AFTER INSERT ON tracks BEGIN
          INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
          VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre);
        END;

        CREATE TRIGGER tracks_fts_delete AFTER DELETE ON tracks BEGIN
          INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
          VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre);
        END;

        CREATE TRIGGER tracks_fts_update AFTER UPDATE ON tracks BEGIN
          INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, album_artist, genre)
          VALUES ('delete', old.id, old.title, old.artist, old.album, old.album_artist, old.genre);
          INSERT INTO tracks_fts(rowid, title, artist, album, album_artist, genre)
          VALUES (new.id, new.title, new.artist, new.album, new.album_artist, new.genre);
        END;

        CREATE TABLE library_folders (
          path       TEXT PRIMARY KEY,
          added_at   INTEGER NOT NULL,
          last_scan_at INTEGER
        );

        CREATE TABLE scan_runs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          folder      TEXT,
          started_at  INTEGER NOT NULL,
          finished_at INTEGER,
          indexed     INTEGER NOT NULL DEFAULT 0,
          updated     INTEGER NOT NULL DEFAULT 0,
          skipped     INTEGER NOT NULL DEFAULT 0,
          failed      INTEGER NOT NULL DEFAULT 0,
          pruned      INTEGER NOT NULL DEFAULT 0
        );

        -- Reserved for M3 (yt-dlp). Created now so the schema documents the
        -- intended shape: a resolved, time-limited URL plus its expiry.
        CREATE TABLE sources (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT    NOT NULL,
          external_id  TEXT    NOT NULL,
          web_url      TEXT,
          resolved_url TEXT,
          resolved_at  INTEGER,
          expires_at   INTEGER,
          UNIQUE (kind, external_id)
        );

        -- Reserved for M4 (retention: cache / keep).
        CREATE TABLE cache_entries (
          track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
          path         TEXT    NOT NULL,
          size_bytes   INTEGER NOT NULL,
          complete     INTEGER NOT NULL DEFAULT 0,
          pinned       INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 2,
    name: 'track artwork',
    up: (db) => {
      // Three states in one nullable column, which is what keeps artwork cheap:
      //   NULL  - never looked at (the vast majority of rows after a scan)
      //   ''    - looked at, and the file has no embedded cover (negative cache)
      //   other - the file name of a resized cover in cache/artwork
      // Without the negative case, every album without art would be re-parsed on
      // every visit; without the NULL case there is no way to tell "not yet" from
      // "none".
      db.exec(`ALTER TABLE tracks ADD COLUMN artwork_key TEXT`)
    }
  },
  {
    version: 3,
    name: 'playlists',
    up: (db) => {
      // Playlists are hand-ordered, so `position` is the order and is the only
      // thing that matters. It is stored with gaps (see `PlaylistRepository`)
      // rather than as a dense 0..n-1 sequence: inserting between two rows then
      // costs one UPDATE instead of renumbering everything below it, which is
      // the difference between a drag landing instantly and rewriting a large
      // playlist on every drop.
      //
      // `sort_order` orders the *list of playlists* in the sidebar, which is a
      // separate concern from the order of tracks inside one.
      db.exec(`
        CREATE TABLE playlists (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0
        );

        CREATE UNIQUE INDEX idx_playlists_name ON playlists(name COLLATE NOCASE);
        CREATE INDEX idx_playlists_order ON playlists(sort_order, id);

        -- ON DELETE CASCADE is the whole answer to "what happens to a playlist
        -- when the file is gone": while local tracks have no notion of being
        -- temporarily unavailable, an entry for a row that no longer exists is
        -- only ever a dangling reference. The unique index keeps the same track
        -- out of the same playlist twice, which is what every "Add to playlist"
        -- action that is clicked twice means.
        CREATE TABLE playlist_items (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
          track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL,
          added_at    INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX idx_playlist_items_track ON playlist_items(playlist_id, track_id);
        CREATE INDEX idx_playlist_items_order ON playlist_items(playlist_id, position);
        CREATE INDEX idx_playlist_items_track_id ON playlist_items(track_id);
      `)
    }
  }
]
