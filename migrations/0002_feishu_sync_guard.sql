-- One row that serializes Feishu syncs across isolates and holds a short
-- cooldown after each run. Until this migration is applied, the worker still
-- serializes syncs inside a single isolate and skips the D1 lock.
CREATE TABLE IF NOT EXISTS feishu_sync_guard (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  owner TEXT
);

INSERT OR IGNORE INTO feishu_sync_guard (id, state, until_ms, owner)
VALUES ('feishu', 'idle', 0, NULL);
