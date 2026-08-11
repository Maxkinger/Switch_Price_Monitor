import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresAiProviderConfigurationRepository } from "../src/repositories/postgres/ai-provider-configuration-repository";
import type { AppDatabase } from "../src/server/database/types";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, POSTGRES_MIGRATION_DIRECTORY, resetTestSchema } from "./support/postgres";

describe("PostgreSQL AI 供应商密文仓储", () => {
  let database: AppDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    // 每例从空 schema 应用完整真实迁移，保证 bytea、单例约束与 UPSERT 行为由 PostgreSQL 而不是模拟器验证。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
  });

  afterAll(async () => {
    await database.close();
  });

  it("创建固定 id=1 的 bytea 单例并拒绝第二行、错误 nonce 或过短密文", async () => {
    // 若迁移遗漏 CHECK、把 bytea 误写成 TEXT，或允许多配置行，本例的真实 SQL 约束会直接失败。
    const columns = await database.query<{ columnName: string; dataType: string }>(`
      SELECT column_name AS "columnName", data_type AS "dataType"
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_provider_configuration'
      ORDER BY column_name
    `);
    expect(columns.rows).toEqual([
      { columnName: "algorithm_version", dataType: "smallint" },
      { columnName: "ciphertext", dataType: "bytea" },
      { columnName: "id", dataType: "integer" },
      { columnName: "nonce", dataType: "bytea" },
      { columnName: "updated_at", dataType: "timestamp with time zone" },
    ]);
    await expect(database.query("INSERT INTO ai_provider_configuration (id, algorithm_version, nonce, ciphertext, updated_at) VALUES (2, 1, decode('000000000000000000000000', 'hex'), decode('00112233445566778899aabbccddeeff00', 'hex'), CURRENT_TIMESTAMP)")).rejects.toMatchObject({ code: "23514" });
    await expect(database.query("INSERT INTO ai_provider_configuration (id, algorithm_version, nonce, ciphertext, updated_at) VALUES (1, 1, decode('00', 'hex'), decode('00112233445566778899aabbccddeeff00', 'hex'), CURRENT_TIMESTAMP)")).rejects.toMatchObject({ code: "23514" });
    await expect(database.query("INSERT INTO ai_provider_configuration (id, algorithm_version, nonce, ciphertext, updated_at) VALUES (1, 1, decode('000000000000000000000000', 'hex'), decode('00112233445566778899aabbccddeeff', 'hex'), CURRENT_TIMESTAMP)")).rejects.toMatchObject({ code: "23514" });
  });

  it("以参数化 UPSERT 原子替换密文并由 clear 删除单例", async () => {
    // 若第二次 save 误插入第二行、拼接字节值或 clear 留下旧载荷，读取结果和最终 count 都会暴露该安全回归。
    const repository = new PostgresAiProviderConfigurationRepository(database);
    await repository.saveEncrypted({ algorithmVersion: 1, nonce: new Uint8Array(12).fill(1), ciphertext: new Uint8Array(17).fill(2), updatedAt: "2026-08-11T00:00:00.000Z" });
    await repository.saveEncrypted({ algorithmVersion: 1, nonce: new Uint8Array(12).fill(3), ciphertext: new Uint8Array(18).fill(4), updatedAt: "2026-08-11T00:01:00.000Z" });
    await expect(repository.getEncrypted()).resolves.toEqual({ algorithmVersion: 1, nonce: new Uint8Array(12).fill(3), ciphertext: new Uint8Array(18).fill(4), updatedAt: "2026-08-11T00:01:00.000Z" });
    await repository.clear();
    await expect(repository.getEncrypted()).resolves.toBeNull();
  });
});
