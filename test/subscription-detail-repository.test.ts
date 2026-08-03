import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SubscriptionDetailRepository } from "../src/repositories/postgres/subscription-detail-repository";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("SubscriptionDetailRepository", () => {
  // 详情测试直接驱动 PostgreSQL 仓储，保留路由认证迁移给后续任务，同时覆盖真实 LEFT JOIN 与 BOOLEAN 类型。
  const database = createTestDatabase();
  const details = new SubscriptionDetailRepository(database);

  beforeAll(async () => {
    // 只对固定可丢弃目标重建 schema，正式迁移提供价格、健康状态和目标价的完整外键关系。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  afterAll(async () => {
    // 详情文件结束后关闭独立池，避免后续文件重建 schema 时仍有悬挂连接。
    await database.close();
  });

  beforeEach(async () => {
    // CASCADE 仅清空 disposable schema；identity 重置用于固定相同捕获时间下最新和最低快照的决胜顺序。
    await database.query("TRUNCATE games, regional_products, subscriptions, subscription_regions, subscription_region_targets, price_snapshots, regional_product_health RESTART IDENTITY CASCADE");
  });

  it("returns null for a missing subscription", async () => {
    // 缺失记录由仓储返回 null，再由既有服务转换为安全 404；数据库错误和 SQL 内容不能伪装成不存在。
    await expect(details.find("missing-subscription")).resolves.toBeNull();
  });

  it("returns monitored and available regions with stable snapshots, targets, booleans, and nullable joins", async () => {
    // 未监控但已官方确认的地区仍要显示供管理员重新勾选；没有快照/健康行时必须返回 null 与非 stale，而不是零价格。
    await seedSubscriptionDetail(database);

    await expect(details.find("subscription-detail")).resolves.toEqual({
      subscriptionId: "subscription-detail",
      game: {
        id: "game-detail",
        nameZh: "详情测试游戏",
        nameEn: "Detail Test Game",
        productType: "game",
      },
      enabled: false,
      globalTargetCnyFen: 6500,
      regionTargets: [{ regionCode: "US", targetAmountMinor: 899 }],
      regions: [
        {
          regionalProductId: "product-detail-us",
          regionCode: "US",
          currency: "USD",
          monitored: true,
          current: { amountMinor: 1099, cnyFen: 7450, source: "eshop-prices", capturedAt: "2026-07-16T00:00:00.000Z" },
          historicalLow: { amountMinor: 899, cnyFen: 6100, source: "official", capturedAt: "2026-07-15T00:00:00.000Z" },
          isStale: true,
        },
        {
          regionalProductId: "product-detail-jp",
          regionCode: "JP",
          currency: "JPY",
          monitored: false,
          current: null,
          historicalLow: null,
          isStale: false,
        },
      ],
    });
  });
});

/** 构造一个暂停订阅、一个已监控地区和一个可选地区，集中验证详情读取而不调用 Task 4 的事务写服务。 */
async function seedSubscriptionDetail(database: ReturnType<typeof createTestDatabase>): Promise<void> {
  await database.query(
    "INSERT INTO games (id, name_zh, name_en, product_type, created_at) VALUES ($1, $2, $3, $4, $5)",
    ["game-detail", "详情测试游戏", "Detail Test Game", "game", "2026-07-14T00:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, enabled, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7), ($8, $2, $9, $10, $11, $6, TRUE, $12)`,
    [
      "product-detail-us", "game-detail", "US", "USD", "https://example.test/us", "manual_selection", "2026-07-14T01:00:00.000Z",
      "product-detail-jp", "JP", "JPY", "https://example.test/jp", "2026-07-14T02:00:00.000Z",
    ],
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, global_target_cny_fen, created_at, updated_at)
     VALUES ($1, $2, FALSE, $3, $4, $4)`,
    ["subscription-detail", "game-detail", 6500, "2026-07-14T00:00:00.000Z"],
  );
  await database.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["subscription-detail", "product-detail-us"]);
  await database.query(
    "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES ($1, $2, $3, $4)",
    ["subscription-detail", "US", 899, "unmet"],
  );
  // 最后两条快照捕获时间相等，较大 identity 的第三方记录必须成为 current；更早的 899 官方价仍是历史最低。
  await insertSnapshot(database, 899, 6100, "official", "2026-07-15T00:00:00.000Z");
  await insertSnapshot(database, 999, 6800, "official", "2026-07-16T00:00:00.000Z");
  await insertSnapshot(database, 1099, 7450, "eshop-prices", "2026-07-16T00:00:00.000Z");
  await database.query(
    `INSERT INTO regional_product_health (regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    ["product-detail-us", 1, "2026-07-16T00:00:00.000Z", false, "2026-07-16T06:00:00.000Z"],
  );
}

/** 详情价格夹具使用参数化整数金额和受控来源，避免辅助代码改变价格来源或精度规则。 */
async function insertSnapshot(database: ReturnType<typeof createTestDatabase>, amountMinor: number, cnyFen: number, source: string, capturedAt: string): Promise<void> {
  await database.query(
    `INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["product-detail-us", amountMinor, "USD", cnyFen, source, capturedAt],
  );
}
