-- 目标价功能已从产品永久移除：仅删除其专属通知历史，不能影响官方降价、采集失败或恢复事件。
DELETE FROM notification_events WHERE event_type = 'target-price';

-- 地区目标表只保存目标金额和命中状态；删除前不需要回写订阅或价格历史，避免保留无效配置。
DROP TABLE subscription_region_targets;

-- 全局目标金额与地区目标共同构成已删除功能；移除此列后订阅仍保留启停、地区范围与时间审计字段。
ALTER TABLE subscriptions DROP COLUMN global_target_cny_fen;
