CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regional_product_id TEXT NOT NULL REFERENCES regional_products(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  cny_fen INTEGER,
  exchange_rate REAL,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_product_captured
  ON price_snapshots (regional_product_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency TEXT NOT NULL,
  cny_rate REAL NOT NULL,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  UNIQUE (currency, captured_at)
);

CREATE TABLE IF NOT EXISTS fetch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regional_product_id TEXT REFERENCES regional_products(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  message TEXT,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fetch_logs_captured_at ON fetch_logs (captured_at);

CREATE TABLE IF NOT EXISTS regional_product_health (
  regional_product_id TEXT PRIMARY KEY REFERENCES regional_products(id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  failure_notified INTEGER NOT NULL DEFAULT 0 CHECK (failure_notified IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  regional_product_id TEXT REFERENCES regional_products(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
