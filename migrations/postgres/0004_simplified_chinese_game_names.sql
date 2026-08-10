-- 简体中文名称词条以 normalized_name 的精确值为主键，只补充管理员界面展示；不得借名称相似性改变既有官方商品身份、地区商品关系或采集价格来源。
-- 受控来源与名称长度约束让自动回填只能使用可审计证据，避免空白、超长或任意来源文本在管理员界面被误认作已确认名称。
CREATE TABLE game_name_catalog (
  identity_key TEXT PRIMARY KEY,
  display_name_zh_cn TEXT NOT NULL CHECK (char_length(trim(display_name_zh_cn)) BETWEEN 1 AND 120),
  source TEXT NOT NULL CHECK (source IN ('publisher', 'mainland-platform', 'hk-reference', 'manual')),
  evidence_url TEXT,
  confirmed_at TIMESTAMPTZ NOT NULL
);

-- 旧 games 记录不会在迁移时猜测中文展示名：三个可空元数据列保留 pending 语义，防止历史 name_zh（仅管理候选）被错误提升为展示真值。
ALTER TABLE games ADD COLUMN display_name_zh_cn TEXT;
ALTER TABLE games ADD COLUMN display_name_source TEXT
  CHECK (display_name_source IN ('catalog', 'manual'));
ALTER TABLE games ADD COLUMN display_name_confirmed_at TIMESTAMPTZ;
