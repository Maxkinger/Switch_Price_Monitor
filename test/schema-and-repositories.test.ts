import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PriceRepository } from "../src/repositories/postgres/price-repository";
import type { SqlExecutor } from "../src/server/database/types";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("PriceRepository", () => {
  // 使用可丢弃 PostgreSQL 验证快照不可变语义、BIGINT 计数和 SQL 联表，不用内存 mock 掩盖驱动类型。
  const database = createTestDatabase();
  const prices = new PriceRepository(database);

  beforeAll(async () => {
    // 正式迁移保证价格主键确实为 BIGINT identity，测试因此能覆盖 pg 将 COUNT(*) 返回字符串的真实行为。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 关闭测试池，避免该文件的连接影响后续会重建 public schema 的测试。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 仅作用于 disposable schema，并重置 identity 以固定完全并列最低价的最早主键。
    await database.query("TRUNCATE games, regional_products, price_snapshots RESTART IDENTITY CASCADE");
    await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game"]);
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
      ["jp-overcooked-2", "game-overcooked-2", "JP", "JPY", "https://example.test/jp", "manual-link"],
    );
  });

  it("keeps immutable price history and returns the lowest regional price", async () => {
    // 同一地区连续写入两次不同价格，验证仓储追加而非覆盖，并能为日报正确找到最低本币价格。
    await prices.append({
      regionalProductId: "jp-overcooked-2",
      amountMinor: 1000,
      currency: "JPY",
      cnyFen: 4174,
      source: "official",
      capturedAt: "2026-07-16T00:00:00.000Z",
    });
    await prices.append({
      regionalProductId: "jp-overcooked-2",
      amountMinor: 800,
      currency: "JPY",
      cnyFen: 3339,
      source: "official",
      capturedAt: "2026-07-17T00:00:00.000Z",
    });

    await expect(prices.countForRegionalProduct("jp-overcooked-2")).resolves.toBe(2);
    await expect(prices.lowestForRegionalProduct("jp-overcooked-2")).resolves.toMatchObject({
      regionCode: "JP",
      amountMinor: 800,
      cnyFen: 3339,
      capturedAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("keeps the earliest identity as the historical low when amount and capture time are equal", async () => {
    // 金额和时间完全并列时用 id ASC 选择先到事实，防止查询计划变化导致来源或人民币换算值在页面间跳动。
    await prices.append({ regionalProductId: "jp-overcooked-2", amountMinor: 800, currency: "JPY", cnyFen: 3400, source: "official", capturedAt: "2026-07-17T00:00:00.000Z" });
    await prices.append({ regionalProductId: "jp-overcooked-2", amountMinor: 800, currency: "JPY", cnyFen: 3300, source: "nt-deals", capturedAt: "2026-07-17T00:00:00.000Z" });

    await expect(prices.lowestForRegionalProduct("jp-overcooked-2")).resolves.toMatchObject({ cnyFen: 3400, source: "official" });
  });

  it("rejects BIGINT counts that cannot be represented as a safe JavaScript integer", async () => {
    // pg 对 COUNT(*) 返回字符串；超过 2^53-1 时静默 Number 转换会损坏计数，仓储必须明确失败而不是返回近似值。
    const unsafeExecutor: SqlExecutor = {
      async query<Row>() {
        return { rows: [{ count: "9007199254740992" }] as Row[], rowCount: 1 };
      },
    };

    await expect(new PriceRepository(unsafeExecutor).countForRegionalProduct("jp-overcooked-2")).rejects.toThrow("安全整数");
  });
});
