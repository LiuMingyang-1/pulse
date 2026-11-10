-- Sample task rows for local dev. Load with:
--   npx wrangler d1 execute pulse-db --local --file=./seed.example.sql
--
-- The todo/reminder/schedule/calendar widgets are computed from this table
-- (src/tasks.ts); the `widgets` table only holds pushed blobs like stocks.
--
-- Task field semantics:
--   done            = the checkbox — single completion authority
--   plan_date       = 'YYYY-MM-DD' (Shanghai day): picked for that day but no
--                     time block → shows under "今日选中 · 未排期"
--   scheduled_*     = a real time block → lands on today's timeline + ICS feed
--   due             = independent deadline
--   completed_at    = stamped when done flips to 1; today's completions sink
--                     to the todo card's done section

INSERT OR REPLACE INTO tasks (id, title, type, status, done, due, priority,
  plan_date, scheduled_start, scheduled_end, notes, project, tags,
  calendar_event_id, completed_at, created_at, updated_at) VALUES
  ('ex_t1', 'Write the API design doc', 'Task', 'Inbox', 0,
   '2026-10-10T18:00:00+08:00', 'P1', NULL, NULL, NULL, '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z'),
  ('ex_t2', 'Renew domain example.com', 'Task', 'Inbox', 0,
   '2026-10-15T00:00:00+08:00', 'P0', NULL, NULL, NULL, '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z'),
  ('ex_t3', 'Reply to design review', 'Task', 'Inbox', 0,
   '2026-10-09T18:00:00+08:00', 'P2', NULL, NULL, NULL, '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z'),
  ('ex_t4', 'Morning standup', 'Task', 'Inbox', 0, NULL, 'P2', NULL,
   '2026-10-09T09:30:00+08:00', '2026-10-09T09:45:00+08:00', '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z'),
  ('ex_t5', 'Review sprint demo', 'Task', 'Inbox', 0, NULL, 'P2', NULL,
   '2026-10-09T14:00:00+08:00', '2026-10-09T15:00:00+08:00', '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z'),
  ('ex_t6', 'Book dentist appointment', 'Task', 'Done', 1, NULL, 'P2',
   NULL, NULL, NULL, 'called the clinic, booked Fri 3pm', NULL, NULL, NULL,
   '2026-10-09T01:45:00.000Z', '2026-10-08T02:10:00.000Z', '2026-10-09T01:45:00.000Z'),
  ('ex_r1', 'Water the plants', 'Reminder', 'Inbox', 0,
   '2026-10-10T09:00:00+08:00', 'P2', NULL, NULL, NULL, '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z'),
  ('ex_r2', 'Take out recycling', 'Reminder', 'Inbox', 0,
   '2026-10-11T20:00:00+08:00', 'P2', NULL, NULL, NULL, '', NULL, NULL, NULL, NULL,
   '2026-10-09T02:10:00.000Z', '2026-10-09T02:10:00.000Z');
