-- Queue-It buyer line for purchase day: order of people entering Comic-Con's virtual queue.
CREATE TABLE IF NOT EXISTS purchase_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK(status IN ('waiting', 'on_deck', 'in_queueit', 'buying', 'done', 'skipped')),
  -- Minutes remaining from Queue-It screen; null = not reported yet. Sort key for prep order.
  eta_minutes INTEGER,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, participant_id),
  UNIQUE(event_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_queue_event_pos ON purchase_queue(event_id, position);
