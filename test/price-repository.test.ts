import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { PriceRepository } from "../src/worker/repositories/price-repository";

describe("PriceRepository", () => {
  beforeEach(async () => {
    // 价格快照依赖地区商品；以真实 D1 重建最小夹具，验证“上一条官方价”不会被更晚的第三方价格混淆。
    await env.DB.exec("DELETE FROM price_snapshots; DELETE FROM regional_products; DELETE FROM games;");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)").bind("game-price", "价格测试游戏", "Price Test Game", "game"),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)").bind("product-price", "game-price", "JP", "JPY", "https://example.test/jp", "manual-link"),
    ]);
  });

  it("returns the newest official snapshot while ignoring a later third-party fallback", async () => {
    // 降价规则只可比较官方连续快照；晚到的第三方数据虽然保留展示价值，但不得成为即时提醒的比较基线。
    await env.DB.batch([
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at) VALUES (?, ?, ?, ?, ?)").bind("product-price", 1000, "JPY", "official", "2026-07-16T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at) VALUES (?, ?, ?, ?, ?)").bind("product-price", 900, "JPY", "official", "2026-07-16T06:00:00.000Z"),
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at) VALUES (?, ?, ?, ?, ?)").bind("product-price", 800, "JPY", "nt-deals", "2026-07-16T12:00:00.000Z"),
    ]);

    await expect(new PriceRepository(env.DB).latestOfficialFor("product-price")).resolves.toEqual({ amountMinor: 900, source: "official" });
  });
});
