-- 全局设置为单管理员单例；地区数组暂以 JSON 保存，默认搜索区必须由服务层验证属于该数组。
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

-- games 表保存跨区可归并的逻辑商品；标题与发行商供后续防止本体、DLC、升级包误匹配。
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

-- 每个逻辑商品在每区只能有一个映射；官方链接与匹配来源支持自动与手动修正的可追溯性。
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

-- 订阅以 game_id 唯一并采用软停用，避免用户取消后失去价格历史和最低价比较。
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  global_target_cny_fen INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (game_id)
);

-- 多对多关系记录管理员实际选择监控的地区商品；删除订阅可级联关系，但禁止删除仍被引用的地区商品。
CREATE TABLE IF NOT EXISTS subscription_regions (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  regional_product_id TEXT NOT NULL REFERENCES regional_products(id) ON DELETE RESTRICT,
  PRIMARY KEY (subscription_id, regional_product_id)
);

-- 单区目标价优先于全局人民币目标价；target_state 用于仅在首次命中时通知，价格回升后由任务重置。
CREATE TABLE IF NOT EXISTS subscription_region_targets (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  region_code TEXT NOT NULL,
  target_amount_minor INTEGER NOT NULL,
  target_state TEXT NOT NULL DEFAULT 'unmet' CHECK (target_state IN ('unmet', 'met')),
  PRIMARY KEY (subscription_id, region_code)
);
