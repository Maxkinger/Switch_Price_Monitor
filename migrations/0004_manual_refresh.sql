-- 单行队列记录管理员最近一次手动刷新请求；id=1 让跨标签页的冷却判断可由一次原子 UPSERT 串行化。
CREATE TABLE IF NOT EXISTS manual_refresh_requests (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running'))
);
