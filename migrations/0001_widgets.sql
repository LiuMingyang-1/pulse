-- Migration: widgets table (see SPEC.md "Widget 数据格式")
-- Each widget is one row: id is the widget key ('schedule', 'todo', 'stocks'),
-- data is a JSON blob whose shape is defined per-widget by the renderer/agent contract.
CREATE TABLE widgets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  data JSON NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT
);
