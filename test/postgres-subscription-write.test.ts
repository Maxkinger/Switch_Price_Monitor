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
          id: "product-jp",
          regionCode: "JP",
          currency: "JPY",
          officialPriceId: "official-jp",
          productUrl: "https://store.nintendo.example/jp/product-jp",
          matchSource: "manual_link",
        }],
        fixedNow,
      ),
    ).rejects.toThrow("合成订阅事务故障");

    await expect(countRows(database, "regional_products")).resolves.toBe(1);
    await expect(countRows(database, "subscription_regions")).resolves.toBe(1);
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
    await expect(countRows(database, "regional_products")).resolves.toBe(1);
    await expect(countRows(database, "subscriptions")).resolves.toBe(1);
  });

  it("永久删除中途故障时恢复已经删除的价格与全部业务主档", async () => {
    const confirmationRepository = new PostgresSubscriptionConfirmationRepository(database);
    await confirmationRepository.createAtomically(
      [confirmation("game-delete-rollback", "subscription-delete-rollback", "deletion rollback")],
      fixedNow,
    );
    await database.query(
      `INSERT INTO price_snapshots (
         regional_product_id, amount_minor, currency, cny_fen, source, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      ["game-delete-rollback-product-us", 1999, "USD", 14300, "official", fixedNow],
    );
    const subscriptions = new PostgresSubscriptionRepository(
      // 第六条事务查询前，目标验证及若干 DELETE 已执行；只有真实回滚能恢复刚删除的价格快照。
      failTransactionBeforeQuery(database, 6),
    );

    await expect(
      subscriptions.deleteMany(["subscription-delete-rollback"]),
    ).rejects.toThrow("合成订阅事务故障");
    await expect(countRows(database, "price_snapshots")).resolves.toBe(1);
    await expect(countRows(database, "games")).resolves.toBe(1);
    await expect(countRows(database, "subscriptions")).resolves.toBe(1);
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

/** 合成确认包含一个已由服务重验的美区商品，固定字面值让断言不复刻生产 ID 或规范化算法。 */
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
    regions: [{
      id: `${gameId}-product-us`,
      regionCode: "US",
      currency: "USD",
      officialPriceId: `${gameId}-official-us`,
      productUrl: `https://www.nintendo.example/us/${gameId}`,
      matchSource: "manual_selection",
    }],
  };
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
  table: "games" | "regional_products" | "subscriptions" | "subscription_regions" | "price_snapshots",
): Promise<number> {
  const result = await database.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  );
  return Number(result.rows[0]?.count ?? "0");
}
