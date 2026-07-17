-- 单管理员凭据表只允许主键 1，避免在个人部署中意外扩展为多账户系统。
-- 密码和恢复码均只保存加盐派生值；即使 D1 数据被读取，也不能直接用于登录。
CREATE TABLE IF NOT EXISTS admin_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  recovery_salt TEXT NOT NULL,
  -- 恢复码成功使用后永久标记失效，避免同一恢复码被重放以二次夺取账户。
  recovery_used_at TEXT,
  created_at TEXT NOT NULL
);

-- Cookie 中的原始令牌不入库；只保存 SHA-256 摘要，并以撤销时间支持单设备退出和密码重设全量失效。
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- 个人站点只有一个管理员，因此失败计数按管理员账户聚合；连续五次失败后使用 locked_until 临时限制猜测。
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
