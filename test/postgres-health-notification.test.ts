import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase } from "../src/server/database/types";
import { PostgresNotificationEventRepository } from "../src/repositories/postgres/notification-event-repository";
import { PostgresProductHealthRepository } from "../src/repositories/postgres/product-health-repository";
import { createTestDatabase, POSTGRES_MIGRATION_DIRECTORY, resetTestSchema } from "./support/postgres";

describe("PostgreSQL 商品健康与通知事件仓储", () => {
  let database: AppDatabase;
  beforeAll(async () => { database = await createTestDatabase(); });
  beforeEach(async () => {
    // 健康与通知依赖地区商品外键；每例重建后只插入固定脱敏主档，避免跨例 dedupe key 冲突。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
    await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ('game-health', '健康测试', 'Health Test', 'game')");
    await database.query(
      `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source)
       VALUES ('product-health', 'game-health', 'US', 'USD', 'https://example.test/us', 'manual-link')`,
    );
  });
  afterAll(async () => { await database.close(); });

  it("读写原生 BOOLEAN 健康状态且失败更新不覆盖最近成功时间", async () => {
    const repository = new PostgresProductHealthRepository(database);
    await expect(repository.get("product-health")).resolves.toEqual({ consecutiveFailures: 0, failureNotified: false });
    await repository.save("product-health", { consecutiveFailures: 0, failureNotified: false }, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z");
    await repository.save("product-health", { consecutiveFailures: 3, failureNotified: true }, null, "2026-07-16T06:00:00.000Z");
    await expect(repository.get("product-health")).resolves.toEqual({ consecutiveFailures: 3, failureNotified: true });
    const row = await database.query<{ lastSuccessAt: Date }>(
      `SELECT last_success_at AS "lastSuccessAt" FROM regional_product_health WHERE regional_product_id = 'product-health'`,
    );
    expect(row.rows[0]?.lastSuccessAt.toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("两个并发预留都不报错且唯一键只授予一次发送资格", async () => {
    const repository = new PostgresNotificationEventRepository(database);
    const input = {
      regionalProductId: "product-health",
      eventType: "collection-failure" as const,
      dedupeKey: "product-health:failure:fixed",
      createdAt: "2026-07-16T06:00:00.000Z",
    };
    // 不等待第一笔 INSERT 就启动第二笔，真实覆盖两个池查询竞争同一 dedupe_key；ON CONFLICT 必须让两者都正常完成。
    const concurrentReservations = Promise.all([
      repository.reserve(input),
      repository.reserve(input),
    ]);
    await expect(concurrentReservations).resolves.toHaveLength(2);
    const results = await concurrentReservations;
    expect(results.filter((reserved) => reserved)).toHaveLength(1);
    expect(results).toContain(false);
    expect(results).toContain(true);
  });

  it("只把 pending 通知确认一次并保留首次成功时间", async () => {
    const repository = new PostgresNotificationEventRepository(database);
    const input = {
      regionalProductId: "product-health",
      eventType: "collection-failure" as const,
      dedupeKey: "product-health:delivery:fixed",
      createdAt: "2026-07-16T06:00:00.000Z",
    };
    await expect(repository.reserve(input)).resolves.toBe(true);
    await expect(repository.markDelivered(input.dedupeKey, "2026-07-16T06:00:01.000Z")).resolves.toBe(true);
    await expect(repository.markDelivered(input.dedupeKey, "2026-07-16T06:00:02.000Z")).resolves.toBe(false);
  });

  it("同时间待发送事件按 identity 排序且允许关联字段为空", async () => {
    const repository = new PostgresNotificationEventRepository(database);
    await repository.reserve({ regionalProductId: "product-health", eventType: "collection-failure", dedupeKey: "event-linked", createdAt: "2026-07-16T06:00:00.000Z" });
    await repository.reserve({ regionalProductId: null, eventType: "target-price", dedupeKey: "event-null", createdAt: "2026-07-16T06:00:00.000Z" });
    await expect(repository.pending()).resolves.toEqual([
      {
        regionalProductId: "product-health",
        eventType: "collection-failure",
        dedupeKey: "event-linked",
        createdAt: "2026-07-16T06:00:00.000Z",
        gameNameZh: "健康测试",
        regionCode: "US",
      },
      {
        regionalProductId: null,
        eventType: "target-price",
        dedupeKey: "event-null",
        createdAt: "2026-07-16T06:00:00.000Z",
        gameNameZh: null,
        regionCode: null,
      },
    ]);
  });
});
