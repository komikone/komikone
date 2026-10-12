-- Each member's own draft order for who they want to buy for on purchase day.
CREATE TABLE buy_list_entries (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, clerk_user_id, participant_id)
);

CREATE INDEX idx_buy_list_owner ON buy_list_entries(event_id, clerk_user_id, rank);
CREATE INDEX idx_buy_list_participant ON buy_list_entries(participant_id);
