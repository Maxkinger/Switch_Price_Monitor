-- 快照只追加，金额使用最小货币单位；cny_fen/exchange_rate 可空以表示本币成功但汇率暂不可得。
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

-- 最新价格和历史曲线按地区商品与采集时间读取，索引避免长期历史导致每日查询退化。
CREATE INDEX IF NOT EXISTS idx_price_snapshots_product_captured
  ON price_snapshots (regional_product_id, captured_at DESC);

-- 每日汇率与来源独立保存，is_stale 标记回退到最近一次成功值，不能伪装为当日中间价。
CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency TEXT NOT NULL,
  cny_rate REAL NOT NULL,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  UNIQUE (currency, captured_at)
);

-- 采集日志仅记录安全错误摘要，90 天后由维护任务清理；地区商品删除时保留诊断记录但解除外键。
CREATE TABLE IF NOT EXISTS fetch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  regional_product_id TEXT REFERENCES regional_products(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  message TEXT,
  captured_at TEXT NOT NULL
);

-- 按捕获时间索引支持固定 90 天保留任务与最近异常列表，避免扫描全部日志。
CREATE INDEX IF NOT EXISTS idx_fetch_logs_captured_at ON fetch_logs (captured_at);

-- 连续失败和已通知标记让三次失败/恢复提醒跨 Cron 执行保持去重，而不是每轮重复打扰管理员。
CREATE TABLE IF NOT EXISTS regional_product_health (
  regional_product_id TEXT PRIMARY KEY REFERENCES regional_products(id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  failure_notified INTEGER NOT NULL DEFAULT 0 CHECK (failure_notified IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 通知事件以 dedupe_key 唯一化，避免重试、并发 Cron 或分页发送时重复推送同一业务事件。
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
