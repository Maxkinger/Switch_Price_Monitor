import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ProductHealthService } from "../src/worker/services/product-health-service";

describe("ProductHealthService", () => {
  beforeEach(async () => {
    // 健康状态引用地区商品；按外键逆序清理并创建最小商品夹具，验证的是 D1 持久化而非内存中的连续失败计数。
    await env.DB.exec("DELETE FROM regional_product_health; DELETE FROM regional_products; DELETE FROM games;");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)").bind("game-health", "健康状态测试游戏", "Health Test Game", "game"),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)").bind("product-health", "game-health", "US", "USD", "https://example.test/us", "manual-link"),
    ]);
  });

  it("persists the third-failure alert state and emits one recovery after a later success", async () => {
    // 三次失败跨独立服务调用模拟三个 Cron 周期；成功后读取 D1 行验证计数、通知标记与最后成功时间都已安全重置。
    const health = new ProductHealthService(env.DB);

    await expect(health.record("product-health", false, "2026-07-16T00:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 1 });
    await expect(health.record("product-health", false, "2026-07-16T06:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 2 });
    await expect(health.record("product-health", false, "2026-07-16T12:00:00.000Z")).resolves.toMatchObject({ notification: "failure", consecutiveFailures: 3 });
    await expect(health.record("product-health", true, "2026-07-16T18:00:00.000Z")).resolves.toMatchObject({ notification: "recovered", consecutiveFailures: 0, failureNotified: false });
    await expect(env.DB.prepare("SELECT consecutive_failures AS consecutiveFailures, failure_notified AS failureNotified, last_success_at AS lastSuccessAt FROM regional_product_health WHERE regional_product_id = ?").bind("product-health").first<{ consecutiveFailures: number; failureNotified: number; lastSuccessAt: string | null }>()).resolves.toEqual({ consecutiveFailures: 0, failureNotified: 0, lastSuccessAt: "2026-07-16T18:00:00.000Z" });
  });
});
