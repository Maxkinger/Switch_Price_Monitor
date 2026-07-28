import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { PostgresSubscriptionConfirmationRepository } from "../src/repositories/postgres/subscription-confirmation-repository";
import { PostgresSubscriptionRepository } from "../src/repositories/postgres/subscription-repository";
import { PostgresManualRefreshRepository } from "../src/repositories/postgres/manual-refresh-repository";
import type { ValidatedSubscriptionConfirmation } from "../src/repositories/subscription-confirmation-repository";
import { createTestDatabase } from "./support/postgres";

/**
 * 订阅写测试只连接 brief 指定的回环测试库，并用合成游戏、URL 与 ID 验证真实外键、唯一索引和事务回滚。
 * 测试不访问任天堂、不会写认证材料，也不接触同机其他数据库或容器。
 */
describe("PostgreSQL 订阅确认与永久删除事务", () => {
  let database: AppDatabase;

  beforeEach(async () => {
    // 每例重建 public schema，使规范化唯一键、外键和删除计数不受上一例残留数据影响。
    database = await createTestDatabase();
  });

  afterEach(async () => {
    // 即使断言失败也关闭当前池，避免事务故障用例耗尽测试 PostgreSQL 的连接预算。
    await database.close();
  });

  it("新订阅在地区写入后故障时不留下任何游戏、地区商品或订阅", async () => {
    // 第三条语句前失败意味着游戏与首个地区 INSERT 已发送；只有真实同连接事务才能把两者一起回滚。
    const repository = new PostgresSubscriptionConfirmationRepository(
      failTransactionBeforeQuery(database, 3),
    );

    await expect(
      repository.createAtomically([confirmation("game-rollback", "subscription-rollback", "atomic game")], fixedNow),
    ).rejects.toThrow("合成订阅事务故障");

    await expect(countRows(database, "games")).resolves.toBe(0);
    await expect(countRows(database, "regional_products")).resolves.toBe(0);
    await expect(countRows(database, "subscriptions")).resolves.toBe(0);
    await expect(countRows(database, "subscription_regions")).resolves.toBe(0);
  });

  it("已有订阅补全在关系写入故障时保留原地区且不增加半成品商品", async () => {
    const repository = new PostgresSubscriptionConfirmationRepository(database);
    await repository.createAtomically(
      [confirmation("game-complete", "subscription-complete", "completion game")],
      fixedNow,
    );
    const failing = new PostgresSubscriptionConfirmationRepository(
      failTransactionBeforeQuery(database, 2),
    );

    await expect(
      failing.completeAtomically(
        "subscription-complete",
        "game-complete",
        [{
          id: "product-mx",
          regionCode: "MX",
          currency: "MXN",
          officialPriceId: "official-mx",
          productUrl: "https://www.nintendo.example/mx/product-mx",
          matchSource: "manual_link",
        }],
        fixedNow,
      ),
    ).rejects.toThrow("合成订阅事务故障");

    await expect(countRows(database, "regional_products")).resolves.toBe(2);
    await expect(countRows(database, "subscription_regions")).resolves.toBe(2);
  });

  it("永久删除含缺失 ID 时在任何写入前拒绝并保留全部目标", async () => {
    const confirmationRepository = new PostgresSubscriptionConfirmationRepository(database);
    await confirmationRepository.createAtomically(
      [confirmation("game-delete", "subscription-delete", "deletion game")],
      fixedNow,
    );
    const subscriptions = new PostgresSubscriptionRepository(database);

    await expect(
      subscriptions.deleteMany(["subscription-delete", "subscription-missing"]),
    ).resolves.toBe(false);
    await expect(countRows(database, "games")).resolves.toBe(1);
    await expect(countRows(database, "regional_products")).resolves.toBe(2);
    await expect(countRows(database, "subscriptions")).resolves.toBe(1);
  });

  it("永久删除中途故障时恢复已经删除的价格与全部业务主档", async () => {
    const confirmationRepository = new PostgresSubscriptionConfirmationRepository(database);
    await confirmationRepository.createAtomically(
      [confirmation("game-delete-rollback", "subscription-delete-rollback", "deletion rollback")],
      fixedNow,
    );
    await seedDeletionDependents(
      database,
      "game-delete-rollback",
      "subscription-delete-rollback",
    );
    const subscriptions = new PostgresSubscriptionRepository(
      // 第八条事务查询前，所有从属表 DELETE 已执行；只有真实回滚能恢复完整删除图。
      failTransactionBeforeQuery(database, 8),
    );

    await expect(
      subscriptions.deleteMany(["subscription-delete-rollback"]),
    ).rejects.toThrow("合成订阅事务故障");
    await expectDeletionGraphCounts(database, {
      games: 1,
      regionalProducts: 2,
      subscriptions: 1,
      subscriptionRegions: 2,
      targets: 1,
      snapshots: 2,
      logs: 2,
      health: 2,
      notifications: 2,
    });
    await expectGlobalRowsPreserved(database);
  });

  it("永久删除成功清空完整订阅图但保留设置、汇率和认证资料", async () => {
    /**
     * 管理员明确永久删除只授权目标订阅的业务图；全局设置、汇率和认证单例属于共享/安全状态，
     * 即使其时间或币种与被删游戏相同也不得被宽泛条件误删。
     */
    const confirmationRepository = new PostgresSubscriptionConfirmationRepository(database);
    await confirmationRepository.createAtomically(
      [confirmation("game-delete-success", "subscription-delete-success", "deletion success")],
      fixedNow,
    );
    await seedDeletionDependents(
      database,
      "game-delete-success",
      "subscription-delete-success",
    );

    await expect(
      new PostgresSubscriptionRepository(database).deleteMany([
        "subscription-delete-success",
      ]),
    ).resolves.toBe(true);

    await expectDeletionGraphCounts(database, {
      games: 0,
      regionalProducts: 0,
      subscriptions: 0,
      subscriptionRegions: 0,
      targets: 0,
      snapshots: 0,
      logs: 0,
      health: 0,
      notifications: 0,
    });
    await expectGlobalRowsPreserved(database);
  });

  it("并发确认相同规范化游戏只提交一份并把竞争者转换为安全冲突", async () => {
    // 两个实例先后落到数据库唯一索引；失败方不能把表名、约束名或 SQLSTATE 直接传播给路由。
    const first = new PostgresSubscriptionConfirmationRepository(database);
    const second = new PostgresSubscriptionConfirmationRepository(database);
    const attempts = await Promise.allSettled([
      first.createAtomically(
        [confirmation("game-race-a", "subscription-race-a", "normalized race")],
        fixedNow,
      ),
      second.createAtomically(
        [confirmation("game-race-b", "subscription-race-b", "normalized race")],
        fixedNow,
      ),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "SUBSCRIPTION_WRITE_CONFLICT",
      message: "同一游戏已被并发确认。",
    });
    await expect(countRows(database, "games")).resolves.toBe(1);
    await expect(countRows(database, "subscriptions")).resolves.toBe(1);
  });

  it("手动刷新以 PostgreSQL TIMESTAMPTZ 单行保存最新服务端时间", async () => {
    // 临时无冷却规则允许连续请求，但表内只能保留最后一次时间，不能积累管理员行为或创建伪队列。
    const refreshes = new PostgresManualRefreshRepository(database);
    await refreshes.request("2026-07-27T00:01:00.000Z");
    await expect(
      refreshes.request("2026-07-27T00:02:00.000Z"),
    ).resolves.toEqual({
      accepted: true,
      requestedAt: "2026-07-27T00:02:00.000Z",
      nextAllowedAt: "2026-07-27T00:02:00.000Z",
    });
    const stored = await database.query<{ requestedAt: Date }>(
      `SELECT requested_at AS "requestedAt"
         FROM manual_refresh_requests
        WHERE id = 1`,
    );
    expect(stored.rows[0]?.requestedAt.toISOString()).toBe("2026-07-27T00:02:00.000Z");
  });
});

const fixedNow = "2026-07-27T00:00:00.000Z";

/** 合成确认至少包含美、日两个已重验地区，避免单区夹具掩盖多地区循环中途失败或关系遗漏。 */
function confirmation(
  gameId: string,
  subscriptionId: string,
  normalizedName: string,
): ValidatedSubscriptionConfirmation {
  return {
    game: {
      id: gameId,
      nameZh: "合成游戏",
      nameEn: "Synthetic Game",
      normalizedName,
      publisher: "Synthetic Publisher",
      productType: "game",
      coverUrl: null,
    },
    subscriptionId,
    regions: [
      {
        id: `${gameId}-product-us`,
        regionCode: "US",
        currency: "USD",
        officialPriceId: `${gameId}-official-us`,
        productUrl: `https://www.nintendo.example/us/${gameId}`,
        matchSource: "manual_selection",
      },
      {
        id: `${gameId}-product-jp`,
        regionCode: "JP",
        currency: "JPY",
        officialPriceId: `${gameId}-official-jp`,
        productUrl: `https://store.nintendo.example/jp/${gameId}`,
        matchSource: "manual_link",
      },
    ],
  };
}

/**
 * 为永久删除构造完整依赖图：目标价、两区价格/日志/健康状态以及分别按订阅和商品关联的通知。
 * 同时写入设置、汇率和认证单例作为不得删除的哨兵；所有值均为合成数据，不包含真实凭据或来源响应。
 */
async function seedDeletionDependents(
  database: AppDatabase,
  gameId: string,
  subscriptionId: string,
): Promise<void> {
  const productIds = [`${gameId}-product-us`, `${gameId}-product-jp`];
  await database.query(
    `INSERT INTO subscription_region_targets (
       subscription_id, region_code, target_amount_minor, target_state
     ) VALUES ($1, 'US', 1500, 'met')`,
    [subscriptionId],
  );
  for (const [index, productId] of productIds.entries()) {
    const currency = index === 0 ? "USD" : "JPY";
    await database.query(
      `INSERT INTO price_snapshots (
         regional_product_id, amount_minor, currency, cny_fen, source, captured_at
       ) VALUES ($1, $2, $3, $4, 'official', $5)`,
      [productId, 1999 + index, currency, 14300 + index, fixedNow],
    );
    await database.query(
      `INSERT INTO fetch_logs (
         regional_product_id, source, status, duration_ms, message, captured_at
       ) VALUES ($1, 'official', 'success', 25, NULL, $2)`,
      [productId, fixedNow],
    );
    await database.query(
      `INSERT INTO regional_product_health (
         regional_product_id, consecutive_failures, last_success_at, failure_notified, updated_at
       ) VALUES ($1, 0, $2, FALSE, $2)`,
      [productId, fixedNow],
    );
  }
  await database.query(
    `INSERT INTO notification_events (
       subscription_id, regional_product_id, event_type, status, dedupe_key, created_at
     ) VALUES
       ($1, NULL, 'target-reached', 'pending', $2, $3),
       (NULL, $4, 'collection-failure', 'pending', $5, $3)`,
    [
      subscriptionId,
      `${subscriptionId}:target`,
      fixedNow,
      productIds[0],
      `${subscriptionId}:health`,
    ],
  );
  await database.query(
    `INSERT INTO settings (
       id, enabled_regions_json, default_search_region, created_at, updated_at
     ) VALUES (1, '["US","JP"]'::jsonb, 'US', $1, $1)`,
    [fixedNow],
  );
  await database.query(
    `INSERT INTO exchange_rates (
       currency, cny_rate, source, captured_at, is_stale
     ) VALUES ('USD', 7.2, 'synthetic-central-bank', $1, FALSE)`,
    [fixedNow],
  );
  await database.query(
    `INSERT INTO admin_credentials (
       id, password_hash, password_salt, recovery_hash, recovery_salt, created_at
     ) VALUES (1, 'synthetic-password-hash', 'synthetic-password-salt',
               'synthetic-recovery-hash', 'synthetic-recovery-salt', $1)`,
    [fixedNow],
  );
}

interface DeletionGraphCounts {
  games: number;
  regionalProducts: number;
  subscriptions: number;
  subscriptionRegions: number;
  targets: number;
  snapshots: number;
  logs: number;
  health: number;
  notifications: number;
}

/** 逐表断言完整业务图，确保测试不会只凭主表数量误判删除或回滚正确。 */
async function expectDeletionGraphCounts(
  database: AppDatabase,
  expected: DeletionGraphCounts,
): Promise<void> {
  await expect(countRows(database, "games")).resolves.toBe(expected.games);
  await expect(countRows(database, "regional_products")).resolves.toBe(expected.regionalProducts);
  await expect(countRows(database, "subscriptions")).resolves.toBe(expected.subscriptions);
  await expect(countRows(database, "subscription_regions")).resolves.toBe(expected.subscriptionRegions);
  await expect(countRows(database, "subscription_region_targets")).resolves.toBe(expected.targets);
  await expect(countRows(database, "price_snapshots")).resolves.toBe(expected.snapshots);
  await expect(countRows(database, "fetch_logs")).resolves.toBe(expected.logs);
  await expect(countRows(database, "regional_product_health")).resolves.toBe(expected.health);
  await expect(countRows(database, "notification_events")).resolves.toBe(expected.notifications);
}

/** 共享哨兵必须在回滚和成功删除后都保留，证明删除范围没有扩大到全局或认证状态。 */
async function expectGlobalRowsPreserved(database: AppDatabase): Promise<void> {
  await expect(countRows(database, "settings")).resolves.toBe(1);
  await expect(countRows(database, "exchange_rates")).resolves.toBe(1);
  await expect(countRows(database, "admin_credentials")).resolves.toBe(1);
}

/**
 * 故障包装只替换 transaction 回调看到的执行器；池级查询、BEGIN、ROLLBACK 和 close 仍走生产数据库实现，
 * 因此测试观察的是 PostgreSQL 真回滚，而不是内存 mock 的调用次数。
 */
function failTransactionBeforeQuery(database: AppDatabase, queryNumber: number): AppDatabase {
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => database.transaction(async (transaction) => {
      let executed = 0;
      const failing: SqlExecutor = {
        async query<Row>(sql: string, parameters?: readonly unknown[]) {
          executed += 1;
          if (executed === queryNumber) throw new Error("合成订阅事务故障");
          return transaction.query<Row>(sql, parameters);
        },
      };
      return work(failing);
    }),
    withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
    close: () => Promise.resolve(),
  };
}

/** 表名来自测试内部封闭白名单，动态业务值仍由生产仓储参数绑定，不能扩展为任意 SQL 输入。 */
async function countRows(
  database: AppDatabase,
  table:
    | "games"
    | "regional_products"
    | "subscriptions"
    | "subscription_regions"
    | "subscription_region_targets"
    | "price_snapshots"
    | "fetch_logs"
    | "regional_product_health"
    | "notification_events"
    | "settings"
    | "exchange_rates"
    | "admin_credentials",
): Promise<number> {
  const result = await database.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}
