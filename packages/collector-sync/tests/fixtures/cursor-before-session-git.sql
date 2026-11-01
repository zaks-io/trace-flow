-- Cursor schema from main 901192c4 before TRA-450.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS file_cursors (
    org_id            TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    file_path         TEXT    NOT NULL,
    mtime_ms          REAL    NOT NULL,
    byte_offset       INTEGER NOT NULL,
    content_hash_head TEXT    NOT NULL,
    PRIMARY KEY (org_id, source, file_path)
) WITHOUT ROWID;
-- The SQLite-source (Cursor) watermark. A Cursor sync unit is one *composer* (session) inside the
-- single `state.vscdb`, not a file, so its cursor can't be a `file_cursors` row: there is no
-- byte_offset. The change signal is a hash of its normalized bubbles, with bubble count and newest
-- timestamp retained for diagnostics. Separate table so neither cursor shape carries the other's
-- empty columns; same `(org_id, source, …)` org-isolation and advance-only-after-2xx discipline as
-- `file_cursors`.
CREATE TABLE IF NOT EXISTS composer_cursors (
    org_id         TEXT    NOT NULL,
    source         TEXT    NOT NULL,
    composer_id    TEXT    NOT NULL,
    bubble_count   INTEGER NOT NULL,
    max_created_at INTEGER NOT NULL,
    content_hash   TEXT,
    PRIMARY KEY (org_id, source, composer_id)
) WITHOUT ROWID;
-- Stable fact-level send state. File/composer cursors say a local source unit was accepted; this table
-- says which logical facts inside that unit were already accepted, so a whole-file reparse can upload
-- only new or changed facts. The ingest Worker still owns canonical at-rest IDs; these identities
-- mirror its deterministic input parts for local filtering only.
CREATE TABLE IF NOT EXISTS fact_cursors (
    org_id       TEXT NOT NULL,
    source       TEXT NOT NULL,
    category     TEXT NOT NULL,
    fact_identity TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (org_id, source, category, fact_identity)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS file_parser_versions (
    org_id TEXT NOT NULL, source TEXT NOT NULL, file_path TEXT NOT NULL, version TEXT NOT NULL,
    PRIMARY KEY (org_id, source, file_path)
) WITHOUT ROWID;
-- Units the ingest Worker rejected with a deterministic 400 on their own. A row matches only while
-- the unit's fingerprint (file mtime + size, or composer content) and the parser version are
-- unchanged, so editing the transcript or upgrading the parser retries it automatically.
CREATE TABLE IF NOT EXISTS quarantined_units (
    org_id         TEXT NOT NULL,
    source         TEXT NOT NULL,
    unit_key       TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    PRIMARY KEY (org_id, source, unit_key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cursor_meta (
    org_id TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (org_id, key)
) WITHOUT ROWID;
