CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_regions_json TEXT NOT NULL,
  default_search_region TEXT NOT NULL,
  theme TEXT NOT NULL DEFAULT 'warm-card',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  daily_report_time TEXT NOT NULL DEFAULT '09:00',
  tax_state TEXT NOT NULL DEFAULT 'OR',
  price_history_retention TEXT NOT NULL DEFAULT 'forever',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  normalized_name TEXT,
  publisher TEXT,
  product_type TEXT NOT NULL,
  cover_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS regional_products (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  region_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  official_product_id TEXT,
  product_url TEXT NOT NULL,
  match_source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (game_id, region_code)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  global_target_cny_fen INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (game_id)
);

CREATE TABLE IF NOT EXISTS subscription_regions (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  regional_product_id TEXT NOT NULL REFERENCES regional_products(id) ON DELETE RESTRICT,
  PRIMARY KEY (subscription_id, regional_product_id)
);

CREATE TABLE IF NOT EXISTS subscription_region_targets (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL,
  target_amount_minor INTEGER NOT NULL,
  target_state TEXT NOT NULL DEFAULT 'unmet' CHECK (target_state IN ('unmet', 'met')),
  PRIMARY KEY (subscription_id, region_code)
);
