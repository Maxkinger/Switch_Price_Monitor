-- 既有名称保持不变并标为待同步；迁移不访问任天堂，避免发布时网络失败、外部页面变更或错误匹配误改已在使用的业务展示数据。
ALTER TABLE games ADD COLUMN name_zh_source TEXT NOT NULL DEFAULT 'legacy_pending_sync';
