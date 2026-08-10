-- 代理设置只保存无认证端点；默认关闭确保升级后的 NAS 不会在管理员明确启用前改变既有出站网络路径。
-- 此迁移必须位于目标价删除迁移之后，绝不恢复任何已删除的订阅列、地区表或通知事件。
ALTER TABLE settings
  ADD COLUMN proxy_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN proxy_protocol TEXT NOT NULL DEFAULT 'http'
    CHECK (proxy_protocol IN ('http', 'https', 'socks5')),
  ADD COLUMN proxy_host TEXT NOT NULL DEFAULT '127.0.0.1',
  ADD COLUMN proxy_port INTEGER NOT NULL DEFAULT 7890
    CHECK (proxy_port BETWEEN 1 AND 65535);
