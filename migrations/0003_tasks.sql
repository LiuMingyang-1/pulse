-- Tasks move in-house: D1 is now the source of truth for todo/reminder/
-- schedule/calendar (replacing the Feishu bitable sync). Feishu record_ids
-- are kept as primary keys so ICS UIDs stay stable for subscribers.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                -- feishu record_id for migrated rows, t_<rand> after
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Task',  -- Task | Reminder | Campus
  status TEXT NOT NULL DEFAULT 'Inbox', -- workflow label; completion is `done`, not Status
  done INTEGER NOT NULL DEFAULT 0,    -- the checkbox — single completion authority
  due TEXT,                            -- ISO 8601 deadline
  priority TEXT NOT NULL DEFAULT 'P2', -- P0..P3
  plan_date TEXT,                      -- 'YYYY-MM-DD' (Shanghai day): picked for that day, no time block
  scheduled_start TEXT,                -- ISO 8601
  scheduled_end TEXT,
  notes TEXT NOT NULL DEFAULT '',      -- completion notes, one line each
  project TEXT,
  tags TEXT,
  calendar_event_id TEXT,              -- written by the agent when it slots a calendar event
  completed_at TEXT,                   -- stamped when done flips to 1
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
