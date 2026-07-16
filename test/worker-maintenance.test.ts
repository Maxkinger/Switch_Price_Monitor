import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/worker";

describe("six-hour Worker maintenance", () => {
  beforeEach(async () => {
    // 维护测试使用真实 D1，按外键逆序清理并重建最小设置与商品，确保 Cron 接线不会被纯服务 mock 掩盖。
    await env.DB.exec("DELETE FROM fetch_logs; DELETE FROM price_snapshots; DELETE FROM regional_products; DELETE FROM games; DELETE FROM settings;");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (id, enabled_regions_json, default_search_region, price_history_retention, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)").bind('["US"]', "US", "one-year", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
      env.DB.prepare("INSERT INTO games (id, name_zh, name_en, product_type) VALUES (?, ?, ?, ?)").bind("game-worker-maintenance", "维护测试游戏", "Worker Maintenance Game", "game"),
      env.DB.prepare("INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES (?, ?, ?, ?, ?, ?)").bind("product-worker-maintenance", "game-worker-maintenance", "US", "USD", "https://example.test/us", "manual-link"),
    ]);
  });

  it("uses the six-hour Cron event to remove expired snapshots and diagnostic logs", async () => {
    // 两条超期数据验证 Worker 确实执行 D1 清理；日期固定为一年和九十天边界前一毫秒，避免测试依赖机器当前时间。
    await env.DB.batch([
      env.DB.prepare("INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES (?, ?, ?, ?, ?, ?)").bind("product-worker-maintenance", 999, "USD", 6800, "official", "2025-07-15T23:59:59.999Z"),
      env.DB.prepare("INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES (?, ?, ?, ?)").bind("product-worker-maintenance", "official", "failed", "2026-04-16T23:59:59.999Z"),
    ]);
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

    await worker.scheduled!(
      { cron: "0 */6 * * *", scheduledTime: Date.parse("2026-07-16T00:00:00.000Z") } as ScheduledEvent,
      { DB: env.DB } as Env,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(expect.any(Promise));
    await waitUntil.mock.calls[0][0];
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM price_snapshots").first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM fetch_logs").first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });
});
