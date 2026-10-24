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
  },
  {
    version: 4,
    name: 'play state',
    up: (db) => {
      // One row, rewritten in place: this is a snapshot of the last session, not
      // a history. The queue is stored as a JSON array of ids rather than as a
      // table of positions, because nothing ever queries *into* it — it is read
      // once at start-up and written as a whole. Positions are renumbered from
      // the array on read, which keeps a deleted track from leaving a hole in
      // the order.
      //
      // No foreign key on the ids: a track that has been pruned is dropped when
      // the state is loaded, and a queue entry is not something the database
      // should refuse to write because a file went away mid-session.
      db.exec(`
        CREATE TABLE play_state (
          id           INTEGER PRIMARY KEY CHECK (id = 1),
          queue        TEXT    NOT NULL,
          cursor       INTEGER NOT NULL,
          position_ms  INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 5,
    name: 'online history',
    up: (db) => {
      // The links the user has pasted, remembered so the Online view is a
      // collection rather than a scratch pad. A row is metadata only: there is no
      // `tracks` row and no file until the user asks to save one (M4), so this
      // table deliberately has no foreign key into the library.
      //
      // `video_id` is the identity: pasting the same link twice refreshes one
      // row instead of adding another. Ordering is "most recent activity first",
      // where activity is either being added or being played, so the finished
      // sort is `MAX(COALESCE(last_played_at, 0), added_at)` in the repository —
      // an expression an index cannot serve well, which is why only the played
      // column is indexed and the list is capped on read.
      db.exec(`
        CREATE TABLE online_tracks (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id       TEXT    NOT NULL,
          title          TEXT    NOT NULL,
          artist         TEXT,
          album          TEXT,
          duration_ms    INTEGER,
          source_url     TEXT    NOT NULL,
          artwork_key    TEXT,
          added_at       INTEGER NOT NULL,
          last_played_at INTEGER
        );

        CREATE UNIQUE INDEX idx_online_tracks_video ON online_tracks(video_id);
        CREATE INDEX idx_online_tracks_played ON online_tracks(last_played_at DESC);
      `)
    }
  },
  {
    version: 6,
    name: 'online playlists',
    up: (db) => {
      // A playlist imported from a link is a *snapshot*, not a mirror: it is
      // written once, re-importing the same list id replaces its items, and
      // nothing syncs in the background. `list_id` is the identity, so importing
      // the same URL twice refreshes one playlist instead of piling up copies.
      //
      // The items are deliberately not `online_tracks` rows. The history is a log
      // of what was played and each video appears there once; a playlist entry is
      // a position in a list, and the same video may sit in several lists. Keeping
      // them apart also means removing a history row cannot silently empty part of
      // an imported album.
      db.exec(`
        CREATE TABLE online_playlists (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          list_id      TEXT    NOT NULL,
          kind         TEXT    NOT NULL,
          title        TEXT    NOT NULL,
          owner        TEXT,
          source_url   TEXT    NOT NULL,
          cover_key    TEXT,
          total_count  INTEGER,
          imported_at  INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX idx_online_playlists_list ON online_playlists(list_id);
        CREATE INDEX idx_online_playlists_imported ON online_playlists(imported_at DESC);

        CREATE TABLE online_playlist_items (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          playlist_id INTEGER NOT NULL,
          position    INTEGER NOT NULL,
          video_id    TEXT    NOT NULL,
          title       TEXT    NOT NULL,
          artist      TEXT,
          album       TEXT,
          duration_ms INTEGER
        );

        CREATE UNIQUE INDEX idx_online_items_video ON online_playlist_items(playlist_id, video_id);
        CREATE INDEX idx_online_items_order ON online_playlist_items(playlist_id, position);
      `)
    }
  },
  {
    version: 7,
    name: 'track origin',
    up: (db) => {
      // A saved YouTube track is a normal local file: it plays from disk, works
      // offline, and is scanned like anything else. But the Online views need to
      // know which video it came from, both to say "already in your library" and
      // to avoid downloading it twice. `source_kind`/`source_id` answer "how do I
      // play this"; these columns answer "where did it come from".
      db.exec(`
        ALTER TABLE tracks ADD COLUMN origin_kind TEXT;
        ALTER TABLE tracks ADD COLUMN origin_id TEXT;

        CREATE INDEX idx_tracks_origin ON tracks(origin_kind, origin_id);
      `)
    }
  },
  {
    version: 8,
    name: 'online playlist names',
    up: (db) => {
      // A mix imported from a link is titled after its first track, which is a
      // poor name and not unique. `title` stays the name YouTube reports, so a
      // re-import can still refresh it; a name the user types lives here and
      // wins until they change it again.
      db.exec(`
        ALTER TABLE online_playlists ADD COLUMN custom_title TEXT;
      `)
    }
  },
  {
    version: 9,
    name: 'data care',
    up: (db) => {
      // A row is no longer deleted just because its file vanished. Keeping it
      // preserves playlist entries, play counts and the last known path, so a
      // moved folder can be repaired instead of silently losing history. Lists
      // hide missing rows until they are relocated; `file_hash` is filled in
      // lazily by duplicate detection and makes relocation exact when known.
      db.exec(`
        ALTER TABLE tracks ADD COLUMN missing_at INTEGER;
        ALTER TABLE tracks ADD COLUMN file_hash TEXT;

        CREATE INDEX idx_tracks_file_hash ON tracks(file_hash);
        CREATE INDEX idx_tracks_missing ON tracks(missing_at);
      `)
    }
  },
  {
    version: 10,
    name: 'online track channels',
    up: (db) => {
      // A YouTube link has two possible names: the track artist YouTube may
      // expose, and the uploader/channel. The old row stored only the resolver's
      // fallback (`artist ?? uploader ?? channel`), so there was no way to show
      // both when a real artist existed. Keep the historical value as the
      // channel: it is the uploader for every row written before this column
      // existed, and a re-paste refreshes the pair with the precise values.
      db.exec(`
        ALTER TABLE online_tracks ADD COLUMN channel TEXT;
        UPDATE online_tracks SET channel = artist WHERE channel IS NULL;
      `)
    }
  }
]

/** The schema version this build writes and can open. */
export function latestVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)
}
