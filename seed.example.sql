-- Sample widget rows for local dev. Load with:
--   npx wrangler d1 execute pulse-db --local --file=./seed.example.sql
--
-- Widget data contracts:
--   schedule.data = { "events": [{ "title": string, "start": ISO8601, "end": ISO8601 }] }
--                   only today's slotted events; the card sorts/marks live/past client-side.
--   reminder.data = { "items": [{ "title": string, "due": ISO8601 }] }
--                   every pending reminder; the card shows the next-3-days window.
--   todo.data     = { "pending_count": number,
--                     "items": [{ "title": string, "due": string (ISO8601), "priority": "P0"|"P1"|"P2" }] }
--   stocks.data   = { "total_pnl": number (USD, signed),
--                     "currency": "USD",
--                     "positions": [{ "symbol": string, "shares": number,
--                                     "pnl": number (signed USD), "pct": number (signed %) }] }

INSERT OR REPLACE INTO widgets (id, title, data, updated_at, source) VALUES
  ('schedule', '今日安排',
   '{"events":[{"title":"Morning standup","start":"2026-10-09T09:30:00+08:00","end":"2026-10-09T09:45:00+08:00"},{"title":"Review sprint demo","start":"2026-10-09T14:00:00+08:00","end":"2026-10-09T15:00:00+08:00"}]}',
   '2026-10-09T01:30:00.000Z', 'manual'),

  ('todo', '飞书待办',
   '{"pending_count":3,"items":[{"title":"Write the API design doc","due":"2026-10-10T18:00:00+08:00","priority":"P1"},{"title":"Renew domain example.com","due":"2026-10-15T00:00:00+08:00","priority":"P0"},{"title":"Reply to design review","due":"2026-10-09T18:00:00+08:00","priority":"P2"}]}',
   '2026-10-09T02:10:00.000Z', 'manual'),

  ('reminder', 'Reminder',
   '{"items":[{"title":"Water the plants","due":"2026-10-10T09:00:00+08:00"},{"title":"Take out recycling","due":"2026-10-11T20:00:00+08:00"}]}',
   '2026-10-09T02:10:00.000Z', 'manual'),

  ('stocks', '美股持仓',
   '{"total_pnl":1243.87,"currency":"USD","positions":[{"symbol":"AAPL","shares":10,"pnl":482.30,"pct":21.4},{"symbol":"NVDA","shares":5,"pnl":-156.20,"pct":-3.8},{"symbol":"VOO","shares":3,"pnl":917.77,"pct":12.6}]}',
   '2026-10-09T02:05:00.000Z', 'cron');
