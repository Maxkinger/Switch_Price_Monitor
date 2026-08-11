import type { SqlExecutor } from "../../server/database/types";
import type { AiProviderConfigurationStore, EncryptedAiProviderConfiguration } from "../ports";

/** pg 将 BYTEA 返回 Buffer、TIMESTAMPTZ 返回 Date；行类型在适配器内收窄，避免把驱动格式泄漏到服务层。 */
interface AiProviderConfigurationRow {
  algorithmVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  updatedAt: Date;
}

/**
 * PostgreSQL AI 配置密文仓储只读写 id=1 的不透明二进制载荷。所有值经参数绑定，不能把密文、nonce 或时间拼接进 SQL，
 * 以免二进制编码差异或未来外部输入破坏单例边界；主密钥和明文凭据永远不进入本类。
 */
export class PostgresAiProviderConfigurationRepository implements AiProviderConfigurationStore {
  public constructor(private readonly database: SqlExecutor) {}

  /**
   * 读取单例密文并复制 BYTEA，保证服务修改 Uint8Array 不会影响 pg Buffer。数据库出现不支持的版本时保留原数值给服务安全降级，
   * 因为仓储不能根据版本推测如何解密或把错误伪装成可用配置。
   */
  public async getEncrypted(): Promise<EncryptedAiProviderConfiguration | null> {
    const result = await this.database.query<AiProviderConfigurationRow>(
      `SELECT algorithm_version AS "algorithmVersion",
              nonce,
              ciphertext,
              updated_at AS "updatedAt"
         FROM ai_provider_configuration
        WHERE id = 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      algorithmVersion: row.algorithmVersion as 1,
      nonce: new Uint8Array(row.nonce),
      ciphertext: new Uint8Array(row.ciphertext),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 单条 UPSERT 以固定 id=1 原子替换完整密文；冲突更新不保留旧 nonce 或旧标签，防止替换 Key 后出现半新半旧的认证材料。
   * Buffer 仅用于 pg 参数编码，调用方始终只能看到 Uint8Array，且 SQL 不含任何 API Key、模型或地址列。
   */
  public async saveEncrypted(value: EncryptedAiProviderConfiguration): Promise<void> {
    await this.database.query(
      `INSERT INTO ai_provider_configuration (id, algorithm_version, nonce, ciphertext, updated_at)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET algorithm_version = EXCLUDED.algorithm_version,
             nonce = EXCLUDED.nonce,
             ciphertext = EXCLUDED.ciphertext,
             updated_at = EXCLUDED.updated_at`,
      [value.algorithmVersion, Buffer.from(value.nonce), Buffer.from(value.ciphertext), value.updatedAt],
    );
  }

  /** 删除整个单例而非写入空字符串或伪密文，确保主密钥轮换、管理员清除后读取路径统一表示“未配置”。 */
  public async clear(): Promise<void> {
    await this.database.query("DELETE FROM ai_provider_configuration WHERE id = 1");
  }
}
