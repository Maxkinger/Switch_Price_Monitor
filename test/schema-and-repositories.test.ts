import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { PriceRepository } from "../src/worker/repositories/price-repository";

describe("PriceRepository", () => {
  const prices = new PriceRepository(env.DB);

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM price_snapshots; DELETE FROM regional_products; DELETE FROM games;");
    await env.DB
      .prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)")
      .bind("game-overcooked-2", "胡闹厨房 2", "Overcooked! 2", "game")
      .run();
    await env.DB
      .prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("jp-overcooked-2", "game-overcooked-2", "JP", "JPY", "https://example.test/jp", "manual-link")
      .run();
  });

  it("keeps immutable price history and returns the lowest regional price", async () => {
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
    });
  });
});
