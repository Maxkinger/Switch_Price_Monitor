-- 仅为非空规范化游戏身份建立唯一索引：旧数据允许尚未补齐 normalized_name，新的最终确认必须并发安全地避免重复游戏与订阅。
CREATE UNIQUE INDEX IF NOT EXISTS games_normalized_name_unique
ON games (normalized_name)
WHERE normalized_name IS NOT NULL;
