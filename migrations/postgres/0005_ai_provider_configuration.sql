-- AI 供应商配置是单例 AES-256-GCM 密文载荷，绝不把 API Key、模型或官方地址拆列明文保存；Node 进程私有主密钥不属于 PostgreSQL 备份边界。
-- 12 字节 nonce 是 GCM 的标准长度，每次保存必须重生；密文最少 17 字节确保除 16 字节认证标签外至少有受服务校验过的 UTF-8 JSON 内容。
CREATE TABLE ai_provider_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  algorithm_version SMALLINT NOT NULL CHECK (algorithm_version = 1),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  updated_at TIMESTAMPTZ NOT NULL
);
