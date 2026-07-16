import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SettingsRepository } from "../src/worker/repositories/settings-repository";
import { SubscriptionRepository } from "../src/worker/repositories/subscription-repository";

describe("settings and subscriptions repositories", () => {
  const settings = new SettingsRepository(env.DB);
  const subscriptions = new SubscriptionRepository(env.DB);

  beforeEach(async () => {
    await env.DB.exec(
      "DELETE FROM subscription_regions; DELETE FROM subscriptions; DELETE FROM regional_products; DELETE FROM games; DELETE FROM settings;",
    );
  });

  it("persists the enabled regions and default search region selected during initialization", async () => {
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
