import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { RetentionRepository } from "../src/worker/repositories/retention-repository";
import { RetentionService } from "../src/worker/services/retention-service";

describe("RetentionRepository", () => {
  // 使用真实 D1 数据库验证删除边界；保留边界时刻的记录能避免维护任务比管理员配置更早地丢弃历史。
  const retention = new RetentionRepository(env.DB);

  beforeEach(async () => {
    // 按外键依赖的反向顺序清理测试夹具，使不同测试间不存在残留快照或诊断日志。
    await env.DB.exec("DELETE FROM fetch_logs; DELETE FROM price_snapshots; DELETE FROM regional_products; DELETE FROM games;");
    await env.DB
      .prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)")
      .bind("game-retention", "保留策略测试游戏", "Retention Test Game", "game")
      .run();
    await env.DB
      .prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("product-retention", "game-retention", "US", "USD", "https://example.test/us", "manual-link")
      .run();
  });

  it("deletes only price snapshots older than the configured cutoff", async () => {
    // 截止点前、恰在截止点和截止点后各写一条，验证 SQL 使用严格小于而不是小于等于。
    await env.DB.batch([
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-retention", 1000, "USD", 7000, "official", "2025-07-15T23:59:59.999Z"),
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-retention", 900, "USD", 6300, "official", "2025-07-16T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-retention", 800, "USD", 5600, "official", "2025-07-16T00:00:00.001Z"),
    ]);

    await expect(retention.deletePriceSnapshotsBefore("2025-07-16T00:00:00.000Z")).resolves.toBe(1);
    await expect(env.DB.prepare("SELECT amount_minor AS amountMinor FROM price_snapshots ORDER BY captured_at").all<{ amountMinor: number }>()).resolves.toMatchObject({
      results: [{ amountMinor: 900 }, { amountMinor: 800 }],
    });
  });

  it("deletes only fetch logs older than the fixed diagnostic cutoff", async () => {
    // 日志清理必须独立于价格策略；同样保留边界记录以便恰好 90 天前的故障仍可被管理员查看。
    await env.DB.batch([
      env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES (?, ?, ?, ?)").bind("product-retention", "official", "failed", "2026-04-16T23:59:59.999Z"),
      env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES (?, ?, ?, ?)").bind("product-retention", "official", "failed", "2026-04-17T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES (?, ?, ?, ?)").bind("product-retention", "official", "success", "2026-04-17T00:00:00.001Z"),
    ]);

    await expect(retention.deleteFetchLogsBefore("2026-04-17T00:00:00.000Z")).resolves.toBe(1);
    await expect(env.DB.prepare("SELECT status FROM fetch_logs ORDER BY captured_at").all<{ status: string }>()).resolves.toMatchObject({
      results: [{ status: "failed" }, { status: "success" }],
    });
  });

  it("applies the selected price policy while always cleaning ninety-day diagnostic logs", async () => {
    // 这个集成用例同时验证策略层不会在永久保留时误删价格，并确保日志不会因为价格策略不同而停止清理。
    const service = new RetentionService(retention);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-retention", 1000, "USD", 7000, "official", "2025-07-15T23:59:59.999Z"),
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-retention", 900, "USD", 6300, "official", "2025-07-16T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES (?, ?, ?, ?)").bind("product-retention", "official", "failed", "2026-04-16T23:59:59.999Z"),
      env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES (?, ?, ?, ?)").bind("product-retention", "official", "success", "2026-04-17T00:00:00.000Z"),
    ]);

    await expect(service.cleanup("2026-07-16T00:00:00.000Z", "one-year")).resolves.toEqual({
      priceSnapshotsDeleted: 1,
      fetchLogsDeleted: 1,
    });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM price_snapshots").first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM fetch_logs").first<{ count: number }>()).resolves.toEqual({ count: 1 });
  });
});
