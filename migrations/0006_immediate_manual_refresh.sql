-- 旧表中的 queued/running 代表等待六小时 Cron；立即刷新改为同步执行，因此有意丢弃未消费请求，避免迁移后把未执行任务误报为已完成采集。
DROP TABLE IF EXISTS manual_refresh_requests;

-- 单行记录只用于跨标签页和跨 Worker 实例的十五分钟冷却；不保存管理员、商品、会话、价格或供应商响应。
CREATE TABLE manual_refresh_requests (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  requested_at TEXT NOT NULL
);
