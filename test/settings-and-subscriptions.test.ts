import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SettingsRepository } from "../src/worker/repositories/settings-repository";
import { SubscriptionRepository } from "../src/worker/repositories/subscription-repository";

describe("settings and subscriptions repositories", () => {
  // 两个仓储共享同一临时 D1，以验证设置单例与订阅关系的实际 SQL 行为。
  const settings = new SettingsRepository(env.DB);
  const subscriptions = new SubscriptionRepository(env.DB);

  beforeEach(async () => {
    // 订阅关系依赖商品和地区商品，按依赖反向删除，防止前一用例的配置污染当前断言。
    await env.DB.exec(
      "DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM settings;",
    );
  });

  it("persists the enabled regions and default search region selected during initialization", async () => {
    // 验证首次初始化只需保存必选地区；迁移默认主题仍会被完整设置模型正确读取。
    await settings.saveInitial({
      enabledRegions: ["US", "JP"],
      defaultSearchRegion: "JP",
      createdAt: "2026-07-16T00:00:00.000Z",
    });

    await expect(settings.get()).resolves.toMatchObject({
      enabledRegions: ["US", "JP"],
      defaultSearchRegion: "JP",
      theme: "warm-card",
    });
  });

  it("creates one subscription that references its selected regional products", async () => {
    // 先构造已验证的地区商品，再保存关联，确保测试覆盖关系表而非仅验证订阅主表插入。
    await env.DB
      .prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)")
      .bind("game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game")
      .run();
    await env.DB
      .prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("us-overcooked-2", "game-overcooked-2", "US", "USD", "https://example.test/us", "manual-link")
      .run();

    await subscriptions.create({
      id: "subscription-overcooked-2",
      gameId: "game-overcooked-2",
      regionalProductIds: ["us-overcooked-2"],
      createdAt: "2026-07-16T00:00:00.000Z",
    });

    await expect(subscriptions.findByGameId("game-overcooked-2")).resolves.toMatchObject({
      id: "subscription-overcooked-2",
      regionalProductIds: ["us-overcooked-2"],
    });
  });
});
