import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { CollectionRepository } from "../src/worker/repositories/collection-repository";

describe("CollectionRepository", () => {
  beforeEach(async () => {
    // 采集范围由订阅和地区商品共同决定；按外键反向清理，确保停用状态不受其他测试残留数据影响。
    await env.DB.exec("DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games;");
  });

  it("returns only regional products selected by enabled subscriptions", async () => {
    // 停用订阅与停用地区商品都绝不能继续触发外部商店请求，避免无效采集、误通知和不必要的来源负载。
    await env.DB.batch([
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, publisher, product_type) VALUES (?, ?, ?, ?, ?)").bind("game", "胡闹厨房 2", "Overcooked! 2", "Team17", "game"),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("active-product", "game", "US", "USD", "https://example.test/us", "manual_selection", 1),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("disabled-product", "game", "JP", "JPY", "https://example.test/jp", "manual_selection", 0),
      env.DB.prepare("INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind("active-subscription", "game", 1, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("active-subscription", "active-product"),
      env.DB.prepare("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES (?, ?)").bind("active-subscription", "disabled-product"),
    ]);

    await expect(new CollectionRepository(env.DB).enabledRegionalProducts()).resolves.toEqual([expect.objectContaining({ id: "active-product", regionCode: "US", currency: "USD", canonicalTitle: "Overcooked! 2", publisher: "Team17", productType: "game" })]);
  });
});
