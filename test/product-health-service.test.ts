import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NotificationEventRepository } from "../src/repositories/postgres/notification-event-repository";
import { ProductHealthRepository } from "../src/repositories/postgres/product-health-repository";
import { runMigrations } from "../src/server/database/migrations";
import { ProductHealthService } from "../src/services/product-health-service";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("ProductHealthService", () => {
  // 服务只接收窄仓储端口，测试使用真实 PostgreSQL 验证 BOOLEAN UPSERT 和跨多轮调用的持久状态。
  const database = createTestDatabase();
  const healthRepository = new ProductHealthRepository(database);
  const notificationRepository = new NotificationEventRepository(database);

  beforeAll(async () => {
    // 仅对通过固定 URL 与 marker 校验的 disposable schema 运行正式迁移，避免健康状态测试接触任何真实监控数据。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 显式关闭连接池，确保测试结束后没有 PostgreSQL socket 阻止 Vitest 退出。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 只清理 disposable schema；商品夹具保留真实外键，使通知预留不能引用不存在的地区商品。
    await database.query("TRUNCATE games, regional_products, regional_product_health, notification_events RESTART IDENTITY CASCADE");
    await database.query("INSERT INTO games (id, name_zh, name_en, product_type) VALUES ($1, $2, $3, $4)", ["game-health", "健康状态测试游戏", "Health Test Game", "game"]);
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, $3, $4, $5, $6)",
      ["product-health", "game-health", "US", "USD", "https://example.test/us", "manual-link"],
    );
  });

  it("persists the third-failure alert state and emits one recovery after a later success", async () => {
    // 三次失败跨独立服务调用模拟三个 Cron 周期；成功后读取 PostgreSQL 行验证原生布尔、成功时间和通知均安全重置。
    const health = new ProductHealthService(healthRepository, notificationRepository);

    await expect(health.record("product-health", false, "2026-07-16T00:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 1 });
    await expect(health.record("product-health", false, "2026-07-16T06:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 2 });
    await expect(health.record("product-health", false, "2026-07-16T12:00:00.000Z")).resolves.toMatchObject({ notification: "failure", consecutiveFailures: 3 });
    await expect(health.record("product-health", true, "2026-07-16T18:00:00.000Z")).resolves.toMatchObject({ notification: "recovered", consecutiveFailures: 0, failureNotified: false });
    await expect(healthRepository.get("product-health")).resolves.toEqual({ consecutiveFailures: 0, failureNotified: false });
    const state = await database.query<{ consecutiveFailures: number; failureNotified: boolean; lastSuccessAt: Date }>(
      `SELECT consecutive_failures AS "consecutiveFailures", failure_notified AS "failureNotified", last_success_at AS "lastSuccessAt"
         FROM regional_product_health WHERE regional_product_id = $1`,
      ["product-health"],
    );
    expect(state.rows[0]).toMatchObject({ consecutiveFailures: 0, failureNotified: false });
    expect(state.rows[0]?.lastSuccessAt.toISOString()).toBe("2026-07-16T18:00:00.000Z");
    const events = await database.query<{ eventType: string; status: string }>(`SELECT event_type AS "eventType", status FROM notification_events ORDER BY created_at, id`);
    expect(events.rows).toEqual([{ eventType: "collection-failure", status: "pending" }, { eventType: "collection-recovered", status: "pending" }]);
  });

  it("retains the last successful collection timestamp after a later failure", async () => {
    // 外部来源在成功采集后的单次故障不能抹去 last_success_at；该字段是仪表盘判断数据新鲜度的唯一成功证据，不能用失败轮次时间冒充刷新完成。
    const health = new ProductHealthService(healthRepository, notificationRepository);

    await expect(health.record("product-health", true, "2026-07-16T12:00:00.000Z")).resolves.toMatchObject({ consecutiveFailures: 0, failureNotified: false });
    await expect(health.record("product-health", false, "2026-07-16T18:00:00.000Z")).resolves.toMatchObject({ consecutiveFailures: 1, failureNotified: false });

    const state = await database.query<{ consecutiveFailures: number; lastSuccessAt: Date | null }>(
      `SELECT consecutive_failures AS "consecutiveFailures", last_success_at AS "lastSuccessAt"
         FROM regional_product_health WHERE regional_product_id = $1`,
      ["product-health"],
    );
    expect(state.rows[0]?.consecutiveFailures).toBe(1);
    expect(state.rows[0]?.lastSuccessAt?.toISOString()).toBe("2026-07-16T12:00:00.000Z");
  });
});
