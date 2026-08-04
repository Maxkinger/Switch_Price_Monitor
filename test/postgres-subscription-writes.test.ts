import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SubscriptionConfirmationRepository } from "../src/repositories/postgres/subscription-confirmation-repository";
import { SubscriptionRepository } from "../src/repositories/postgres/subscription-repository";
import type {
  ValidatedConfirmedRegion,
  ValidatedSubscriptionConfirmation,
} from "../src/repositories/subscription-confirmation-repository";
import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

describe("PostgreSQL 订阅事务写入", () => {
  // 真实 PostgreSQL 能验证唯一索引、外键、事务连接绑定和回滚；内存 Map 无法证明这些生产安全边界。
  const database = createTestDatabase();

  beforeAll(async () => {
    // 每个文件只重建已通过双重安全校验的 disposable schema，并执行与 NAS 相同的正式迁移。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  beforeEach(async () => {
    // 覆盖硬删除涉及的全部表，CASCADE 仅用于测试清场；生产代码仍必须按业务保留与外键顺序显式删除。
    await database.query(
      "TRUNCATE notification_events, regional_product_health, fetch_logs, price_snapshots, subscription_region_targets, subscription_regions, subscriptions, regional_products, games, exchange_rates RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    // 关闭连接池，避免并发唯一约束测试留下的连接影响下一个会重建 schema 的测试文件。
    await database.close();
  });

  it("rolls back a new multi-region confirmation after one valid entity write", async () => {
    // 第一个游戏和第一个地区商品均已成功执行后再故障；事务必须让四张业务表最终都保持空白。
    const repository = new SubscriptionConfirmationRepository(failOnTransactionQuery(database, 3));

    await expect(repository.createAtomically([confirmedSubscription("first")], "2026-07-16T00:00:00.000Z"))
      .rejects.toThrow("测试事务故障");

    await expect(coreConfirmationCounts(database)).resolves.toEqual({ games: 0, products: 0, subscriptions: 0, regions: 0 });
  });

  it("rolls back ordinary subscription creation when a regional relation fails", async () => {
    // 普通创建路由使用已有游戏/商品；订阅主档成功后若第一条关系故障，事务必须恢复为零订阅，不能占住 game_id 唯一约束。
    await seedSubscriptionCandidates(database);
    const repository = new SubscriptionRepository(failOnTransactionQuery(database, 5));

    await expect(repository.createOrOpenAtomically({
      id: "subscription-create",
      gameId: "game-create",
      regionalProductIds: ["product-create-us", "product-create-jp"],
      createdAt: "2026-07-16T00:00:00.000Z",
    })).rejects.toThrow("测试事务故障");

    await expect(rowCount(database, "subscriptions")).resolves.toBe(0);
    await expect(rowCount(database, "subscription_regions")).resolves.toBe(0);
    await expect(rowCount(database, "games")).resolves.toBe(1);
    await expect(rowCount(database, "regional_products")).resolves.toBe(2);
  });

  it("rolls back an existing subscription completion when the relation insert fails", async () => {
    // 新地区商品写入成功后关系写入故障，必须只保留补全前的美区锚点，不能让未监控孤儿商品进入后续价格采集。
    await seedExistingSubscription(database);
    const repository = new SubscriptionConfirmationRepository(failOnTransactionQuery(database, 3));
    const additions: ValidatedConfirmedRegion[] = [validatedRegion("jp-product", "JP", "JPY")];

    await expect(repository.completeAtomically("subscription-existing", "game-existing", additions, "2026-07-16T01:00:00.000Z"))
      .rejects.toThrow("测试事务故障");

    await expect(coreConfirmationCounts(database)).resolves.toEqual({ games: 1, products: 1, subscriptions: 1, regions: 1 });
    await expect(rowCount(database, "regional_products", "id = $1", ["jp-product"])).resolves.toBe(0);
  });

  it("restores the old global and regional targets when replacement fails after deletion", async () => {
    // 全局目标更新和旧单区目标删除都已执行后故障；回滚必须恢复原阈值与 met 状态，避免重复或漏发目标价通知。
    await seedExistingSubscription(database);
    await database.query(
      "UPDATE subscriptions SET global_target_cny_fen = $1, updated_at = $2 WHERE id = $3",
      [5000, "2026-07-16T00:30:00.000Z", "subscription-existing"],
    );
    await database.query(
      "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES ($1, $2, $3, $4)",
      ["subscription-existing", "US", 999, "met"],
    );
    const repository = new SubscriptionRepository(failOnTransactionQuery(database, 3));

    await expect(repository.setTargets(
      "subscription-existing",
      4500,
      [{ regionCode: "JP", targetAmountMinor: 800 }],
      "2026-07-16T01:00:00.000Z",
    )).rejects.toThrow("测试事务故障");

    const subscription = await database.query<{ target: number | null; updatedAt: Date }>(
      `SELECT global_target_cny_fen AS target, updated_at AS "updatedAt"
         FROM subscriptions WHERE id = $1`,
      ["subscription-existing"],
    );
    expect(subscription.rows[0]).toMatchObject({ target: 5000 });
    expect(subscription.rows[0]?.updatedAt.toISOString()).toBe("2026-07-16T00:30:00.000Z");
    const targets = await database.query<{ regionCode: string; amount: number; state: string }>(
      `SELECT region_code AS "regionCode", target_amount_minor AS amount, target_state AS state
         FROM subscription_region_targets WHERE subscription_id = $1`,
      ["subscription-existing"],
    );
    expect(targets.rows).toEqual([{ regionCode: "US", amount: 999, state: "met" }]);
  });

  it("restores the old monitored region when replacement fails after deleting it", async () => {
    // 地区编辑先删除美区关系再写日区；若 INSERT 失败，旧关系和更新时间必须一起恢复，价格历史主档则始终不被删除。
    await seedExistingSubscription(database);
    await database.query(
      "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      ["jp-existing", "game-existing", "JP", "JPY", "https://example.test/jp/existing", "manual_selection", "2026-07-16T00:10:00.000Z"],
    );
    const repository = new SubscriptionRepository(failOnTransactionQuery(database, 4));

    await expect(repository.replaceRegionalProductsAtomically(
      "subscription-existing",
      ["jp-existing"],
      "2026-07-16T01:00:00.000Z",
    )).rejects.toThrow("测试事务故障");

    const regions = await database.query<{ regionalProductId: string }>(
      `SELECT regional_product_id AS "regionalProductId"
         FROM subscription_regions WHERE subscription_id = $1`,
      ["subscription-existing"],
    );
    expect(regions.rows).toEqual([{ regionalProductId: "us-existing" }]);
    await expect(rowCount(database, "regional_products")).resolves.toBe(2);
  });

  it("rolls back every permanent-deletion table after earlier deletes have succeeded", async () => {
    // 通知与目标价删除成功后故障；事务回滚必须恢复快照、日志、健康状态、关系、订阅、地区商品和游戏等全部专属事实。
    await seedDeletionGraph(database);
    const before = await deletionCounts(database);
    const repository = new SubscriptionRepository(failOnTransactionQuery(database, 4));

    await expect(repository.deleteMany(["subscription-delete"])).rejects.toThrow("测试事务故障");

    await expect(deletionCounts(database)).resolves.toEqual(before);
  });

  it("rejects a missing permanent-deletion identifier before issuing any write statement", async () => {
    // 多选中任一 ID 缺失时只能执行锁定读取；不能先删存在项再以 false 掩盖部分成功。
    await seedDeletionGraph(database);
    const observed = observeTransactionStatements(database);
    const repository = new SubscriptionRepository(observed.database);

    await expect(repository.deleteMany(["subscription-delete", "subscription-missing"])).resolves.toBe(false);

    expect(observed.statements.some((sql) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql.trim()))).toBe(false);
    await expect(deletionCounts(database)).resolves.toEqual({
      games: 1,
      products: 1,
      subscriptions: 1,
      regions: 1,
      targets: 1,
      snapshots: 1,
      logs: 1,
      health: 1,
      notifications: 1,
    });
  });

  it("keeps exactly one normalized game and no orphan rows under concurrent confirmations", async () => {
    // 两个应用实例可同时完成只读查重；最终唯一索引和每个请求自己的事务必须让失败方整批回滚，而不是留下第二套地区商品。
    const first = new SubscriptionConfirmationRepository(database);
    const second = new SubscriptionConfirmationRepository(database);
    const results = await Promise.allSettled([
      first.createAtomically([confirmedSubscription("concurrent-a", "overcooked 2|team17|game")], "2026-07-16T00:00:00.000Z"),
      second.createAtomically([confirmedSubscription("concurrent-b", "overcooked 2|team17|game")], "2026-07-16T00:00:00.000Z"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(coreConfirmationCounts(database)).resolves.toEqual({ games: 1, products: 2, subscriptions: 1, regions: 2 });
    await expect(rowCount(database, "regional_products", "game_id NOT IN (SELECT id FROM games)")).resolves.toBe(0);
    await expect(rowCount(database, "subscription_regions", "subscription_id NOT IN (SELECT id FROM subscriptions)")).resolves.toBe(0);
  });
});

/** 构造服务已完成官方 URL、币种、价格 ID 和身份复核后的写入模型；浏览器输入绝不会直接进入仓储测试。 */
function confirmedSubscription(suffix: string, normalizedName = `normalized-${suffix}`): ValidatedSubscriptionConfirmation {
  return {
    game: {
      id: `game-${suffix}`,
      nameZh: "胡闹厨房 2",
      nameEn: "Overcooked! 2",
      normalizedName,
      publisher: "Team17",
      productType: "game",
      coverUrl: null,
    },
    subscriptionId: `subscription-${suffix}`,
    regions: [
      validatedRegion(`product-${suffix}-us`, "US", "USD"),
      validatedRegion(`product-${suffix}-jp`, "JP", "JPY"),
    ],
  };
}

/** 单区模型只使用受控地区、币种和官方审计来源；金额快照不属于确认事务，故不在此伪造。 */
function validatedRegion(id: string, regionCode: "US" | "JP", currency: string): ValidatedConfirmedRegion {
  return {
    id,
    regionCode,
    currency,
    officialPriceId: regionCode === "JP" ? "70010000000001" : null,
    productUrl: `https://example.test/${regionCode.toLowerCase()}/${id}`,
    matchSource: "manual_selection",
  };
}

/** 补全夹具建立一条已监控美区关系；测试随后只能追加日区，不得改写既有历史与订阅身份。 */
async function seedExistingSubscription(database: SqlExecutor): Promise<void> {
  await database.query(
    "INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["game-existing", "胡闹厨房 2", "Overcooked! 2", "existing-normalized", "Team17", "game", "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["us-existing", "game-existing", "US", "USD", "https://example.test/us/existing", "manual_selection", "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO subscriptions (id, game_id, created_at, updated_at) VALUES ($1, $2, $3, $3)",
    ["subscription-existing", "game-existing", "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)",
    ["subscription-existing", "us-existing"],
  );
}

/** 普通订阅创建夹具只预置已验证游戏与两个启用地区商品，订阅和关系必须完全由待测事务产生。 */
async function seedSubscriptionCandidates(database: SqlExecutor): Promise<void> {
  await database.query(
    "INSERT INTO games (id, name_zh, name_en, normalized_name, publisher, product_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["game-create", "胡闹厨房 2", "Overcooked! 2", "create-normalized", "Team17", "game", "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    `INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $2, $9, $10, $11, $6, $7)`,
    [
      "product-create-us",
      "game-create",
      "US",
      "USD",
      "https://example.test/us/create",
      "manual_selection",
      "2026-07-16T00:00:00.000Z",
      "product-create-jp",
      "JP",
      "JPY",
      "https://example.test/jp/create",
    ],
  );
}

/**
 * 永久删除夹具覆盖所有必须随订阅擦除的专属表。
 * exchange_rates、设置和认证均不在图中，因为业务保留规则明确禁止硬删除越过订阅专属数据边界。
 */
async function seedDeletionGraph(database: SqlExecutor): Promise<void> {
  await database.query(
    "INSERT INTO games (id, name_zh, name_en, normalized_name, product_type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["game-delete", "待删除游戏", "Delete Game", "delete-game", "game", "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    ["product-delete", "game-delete", "US", "USD", "https://example.test/us/delete", "manual_selection", "2026-07-16T00:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO subscriptions (id, game_id, created_at, updated_at) VALUES ($1, $2, $3, $3)",
    ["subscription-delete", "game-delete", "2026-07-16T00:00:00.000Z"],
  );
  await database.query("INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)", ["subscription-delete", "product-delete"]);
  await database.query(
    "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES ($1, $2, $3, $4)",
    ["subscription-delete", "US", 999, "met"],
  );
  await database.query(
    "INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, cny_fen, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["product-delete", 999, "USD", 7000, "official", "2026-07-16T01:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO fetch_logs (regional_product_id, source, status, message, captured_at) VALUES ($1, $2, $3, $4, $5)",
    ["product-delete", "official", "failed", "脱敏测试失败", "2026-07-16T01:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO regional_product_health (regional_product_id, consecutive_failures, failure_notified, updated_at) VALUES ($1, $2, $3, $4)",
    ["product-delete", 3, true, "2026-07-16T01:00:00.000Z"],
  );
  await database.query(
    "INSERT INTO notification_events (subscription_id, regional_product_id, event_type, status, dedupe_key, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["subscription-delete", "product-delete", "target-price", "pending", "delete-transaction-test", "2026-07-16T01:00:00.000Z"],
  );
}

/** 读取确认核心四表数量，验证失败批次既没有半个主档，也没有失去父记录的关系。 */
async function coreConfirmationCounts(database: SqlExecutor): Promise<{ games: number; products: number; subscriptions: number; regions: number }> {
  return {
    games: await rowCount(database, "games"),
    products: await rowCount(database, "regional_products"),
    subscriptions: await rowCount(database, "subscriptions"),
    regions: await rowCount(database, "subscription_regions"),
  };
}

/** 硬删除回滚检查覆盖每张受影响表，不能只看订阅主表而忽略价格、通知或保留数据。 */
async function deletionCounts(database: SqlExecutor): Promise<Record<string, number>> {
  return {
    games: await rowCount(database, "games"),
    products: await rowCount(database, "regional_products"),
    subscriptions: await rowCount(database, "subscriptions"),
    regions: await rowCount(database, "subscription_regions"),
    targets: await rowCount(database, "subscription_region_targets"),
    snapshots: await rowCount(database, "price_snapshots"),
    logs: await rowCount(database, "fetch_logs"),
    health: await rowCount(database, "regional_product_health"),
    notifications: await rowCount(database, "notification_events"),
  };
}

/** 固定表名来自测试内部白名单，where 子句也只由测试代码提供；所有业务标识仍通过 PostgreSQL 参数绑定。 */
async function rowCount(
  database: SqlExecutor,
  table: "games" | "regional_products" | "subscriptions" | "subscription_regions" | "subscription_region_targets" | "price_snapshots" | "fetch_logs" | "regional_product_health" | "notification_events",
  where = "TRUE",
  parameters: readonly unknown[] = [],
): Promise<number> {
  const result = await database.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, parameters);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count)) throw new Error("测试计数超出安全整数范围。");
  return count;
}

/**
 * 在事务执行器的指定语句前故障；池级 query 不拦截，专门暴露仓储在事务回调中误用独立连接造成的不可回滚写入。
 */
function failOnTransactionQuery(database: AppDatabase, failingQueryNumber: number): AppDatabase {
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => database.transaction(async (transaction) => {
      let queryNumber = 0;
      const failingExecutor: SqlExecutor = {
        query: async (sql, parameters) => {
          queryNumber += 1;
          if (queryNumber === failingQueryNumber) throw new Error("测试事务故障");
          return transaction.query(sql, parameters);
        },
      };
      return work(failingExecutor);
    }),
    withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
    close: () => database.close(),
  };
}

/** 记录事务中的 SQL 结构，用于证明缺失 ID 在第一条 DELETE 前就被拒绝；参数值不进入日志或断言。 */
function observeTransactionStatements(database: AppDatabase): { database: AppDatabase; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    database: {
      query: (sql, parameters) => database.query(sql, parameters),
      transaction: (work) => database.transaction((transaction) => work({
        query: (sql, parameters) => {
          statements.push(sql);
          return transaction.query(sql, parameters);
        },
      })),
      withAdvisoryLock: (key, work) => database.withAdvisoryLock(key, work),
      close: () => database.close(),
    },
  };
}
