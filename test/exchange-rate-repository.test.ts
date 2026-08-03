import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ExchangeRateRepository } from "../src/repositories/postgres/exchange-rate-repository";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("ExchangeRateRepository", () => {
  // 真实 PostgreSQL 测试覆盖 DOUBLE PRECISION、TIMESTAMPTZ 与唯一键行为，避免内存 fake 掩盖驱动类型差异。
  const database = createTestDatabase();
  const rates = new ExchangeRateRepository(database);

  beforeAll(async () => {
    // schema 只在固定回环端口和显式 disposable marker 都通过时重建，绝不对开发或 NAS 数据库执行 DROP。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 每个文件结束时关闭独立连接池，保证后续集成测试不会继承连接或事务状态。
    await database.close();
  });

  beforeEach(async () => {
    // 汇率没有外键依赖；重置 identity 让同一捕获时刻之外的 id 次序仍可在测试中稳定复现。
    await database.query("TRUNCATE exchange_rates RESTART IDENTITY");
  });

  it("appends each captured rate once and returns the newest value as an ISO DTO", async () => {
    // 同币种同捕获时间的任务重试必须由唯一键幂等忽略，但更晚成功值仍要成为后续价格换算基线。
    const first = { currency: "USD", cnyRate: 7.1, source: "test-rate", capturedAt: "2026-07-15T00:00:00.000Z" };
    const latest = { currency: "USD", cnyRate: 7.2, source: "test-rate", capturedAt: "2026-07-16T00:00:00.000Z" };
    await rates.append(first);
    await rates.append(first);
    await rates.append(latest);

    await expect(rates.latestFor("USD")).resolves.toEqual(latest);
    const count = await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM exchange_rates WHERE currency = $1", ["USD"]);
    expect(count.rows[0]?.count).toBe("2");
  });

  it("returns null when a currency has no successful stored rate", async () => {
    // 缺少汇率必须显式返回 null，让服务层决定是否使用带 stale 标记的旧值；仓储不得伪造 1:1 汇率。
    await expect(rates.latestFor("JPY")).resolves.toBeNull();
  });
});
