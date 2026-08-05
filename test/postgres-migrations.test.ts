import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

const migrationsDirectory = resolve("migrations/postgres");
const fixedTime = "2026-08-03T08:00:00.000Z";

/** 为约束测试建立一组合法父记录，后续每条失败写入只改变一个外键或唯一键条件。 */
async function seedConstraintParents(database: SqlExecutor): Promise<void> {
  await database.query(
    `INSERT INTO games (id, name_zh, name_en, normalized_name, product_type, created_at)
     VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
    ["game-1", "游戏一", "Game One", "game-one", "base", fixedTime, "game-2", "游戏二", "Game Two", "game-two", "base", fixedTime],
  );
  await database.query(
    `INSERT INTO regional_products
       (id, game_id, region_code, currency, product_url, match_source, enabled, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7),
            ($8, $9, $10, $11, $12, $13, TRUE, $14)`,
    [
      "regional-1", "game-1", "JP", "JPY", "https://example.invalid/jp/1", "official", fixedTime,
      "regional-2", "game-1", "US", "USD", "https://example.invalid/us/1", "official", fixedTime,
    ],
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ($1, $2, TRUE, $3, $3)`,
    ["subscription-1", "game-1", fixedTime],
  );
  await database.query(
    "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)",
    ["subscription-1", "regional-1"],
  );
  await database.query(
    `INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor)
     VALUES ($1, $2, $3)`,
    ["subscription-1", "JP", 3_000],
  );
  await database.query(
    `INSERT INTO exchange_rates (currency, cny_rate, source, captured_at, is_stale)
     VALUES ($1, $2, $3, $4, FALSE)`,
    ["USD", 7.1, "fixture", fixedTime],
  );
  await database.query(
    `INSERT INTO sessions (id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4)`,
    ["session-1", "token-hash-1", "2026-08-04T08:00:00.000Z", fixedTime],
  );
  await database.query(
    `INSERT INTO notification_events
       (subscription_id, regional_product_id, event_type, status, dedupe_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["subscription-1", "regional-1", "target-met", "pending", "dedupe-1", fixedTime],
  );
}

/** 断言 PostgreSQL 用标准外键错误拒绝孤儿数据，而不是由测试依赖易变的英文错误文案。 */
async function expectForeignKeyViolation(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toMatchObject({ code: "23503" });
}

/** 断言数据库唯一约束承担并发防重职责；SQLSTATE 比具体约束名更能稳定表达契约。 */
async function expectUniqueViolation(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toMatchObject({ code: "23505" });
}

describe("PostgreSQL 初始模式", () => {
  let database: AppDatabase;

  beforeAll(() => {
    database = createTestDatabase();
  });

  beforeEach(async () => {
    // destructive reset 会再次校验固定回环目标与显式 marker；仅持有一个数据库 executor 不足以获得 DROP SCHEMA 权限。
    await resetDisposableTestSchema(database);
    await runMigrations(database, migrationsDirectory);
  });

  afterAll(async () => {
    await database.close();
  });

  it("创建完整的新鲜模式以及读取、保留和并发防重所需索引", async () => {
    const tables = await database.query<{ tableName: string }>(
      `SELECT table_name AS "tableName"
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    expect(tables.rows.map(({ tableName }) => tableName)).toEqual([
      "admin_credentials",
      "exchange_rates",
      "fetch_logs",
      "games",
      "login_attempts",
      "manual_refresh_requests",
      "notification_events",
      "price_snapshots",
      "regional_product_health",
      "regional_products",
      "schema_migrations",
      "sessions",
      "settings",
      "subscription_region_targets",
      "subscription_regions",
      "subscriptions",
    ]);

    const indexes = await database.query<{ indexName: string }>(
      `SELECT indexname AS "indexName"
         FROM pg_indexes
        WHERE schemaname = 'public'`,
    );
    expect(indexes.rows.map(({ indexName }) => indexName)).toEqual(expect.arrayContaining([
      "idx_fetch_logs_captured_at",
      "idx_price_snapshots_product_captured",
      "games_normalized_name_unique",
    ]));
  });

  it("使用 PostgreSQL 原生 BOOLEAN、TIMESTAMPTZ、JSONB 与整数金额类型", async () => {
    const columns = await database.query<{ tableName: string; columnName: string; dataType: string }>(
      `SELECT table_name AS "tableName", column_name AS "columnName", data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const typeOf = (tableName: string, columnName: string) =>
      columns.rows.find((column) => column.tableName === tableName && column.columnName === columnName)?.dataType;

    for (const [tableName, columnName] of [
      ["regional_products", "enabled"],
      ["subscriptions", "enabled"],
      ["exchange_rates", "is_stale"],
      ["regional_product_health", "failure_notified"],
    ]) {
      expect(typeOf(tableName, columnName)).toBe("boolean");
    }

    for (const [tableName, columnName] of [
      ["schema_migrations", "applied_at"],
      ["settings", "created_at"],
      ["settings", "updated_at"],
      ["price_snapshots", "captured_at"],
      ["price_snapshots", "created_at"],
      ["regional_product_health", "last_success_at"],
      ["notification_events", "sent_at"],
      ["admin_credentials", "recovery_used_at"],
      ["sessions", "expires_at"],
      ["sessions", "revoked_at"],
      ["login_attempts", "locked_until"],
      ["manual_refresh_requests", "requested_at"],
    ]) {
      expect(typeOf(tableName, columnName)).toBe("timestamp with time zone");
    }

    expect(typeOf("settings", "enabled_regions_json")).toBe("jsonb");
    for (const [tableName, columnName] of [
      ["subscriptions", "global_target_cny_fen"],
      ["subscription_region_targets", "target_amount_minor"],
      ["price_snapshots", "amount_minor"],
      ["price_snapshots", "cny_fen"],
    ]) {
      expect(typeOf(tableName, columnName)).toBe("integer");
    }
  });

  it("仅新增无认证代理设置列", async () => {
    // 代理首版只能持久化开关、协议、主机和端口；认证、密文和加密密钥字段会扩大秘密管理面，迁移必须明确禁止它们出现。
    const columns = await database.query<{ columnName: string }>(
      `SELECT column_name AS "columnName"
         FROM information_schema.columns
        WHERE table_name = 'settings'`,
    );
    const names = columns.rows.map((row) => row.columnName);
    expect(names).toEqual(expect.arrayContaining([
      "proxy_enabled",
      "proxy_protocol",
      "proxy_host",
      "proxy_port",
    ]));
    expect(names.join(" ")).not.toMatch(/proxy_(user|password|credential|secret|cipher)/i);
  });

  it("由全部业务外键拒绝孤儿记录", async () => {
    await seedConstraintParents(database);
    const invalidTime = "2026-08-03T09:00:00.000Z";

    await expectForeignKeyViolation(database.query(
      `INSERT INTO regional_products
         (id, game_id, region_code, currency, product_url, match_source, created_at)
       VALUES ('bad-regional', 'missing-game', 'HK', 'HKD', 'https://example.invalid/hk', 'official', $1)`,
      [invalidTime],
    ));
    await expectForeignKeyViolation(database.query(
      "INSERT INTO subscriptions (id, game_id, created_at, updated_at) VALUES ('bad-subscription', 'missing-game', $1, $1)",
      [invalidTime],
    ));
    await expectForeignKeyViolation(database.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ('missing-subscription', 'regional-1')",
    ));
    await expectForeignKeyViolation(database.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ('subscription-1', 'missing-regional')",
    ));
    await expectForeignKeyViolation(database.query(
      "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor) VALUES ('missing-subscription', 'US', 100)",
    ));
    await expectForeignKeyViolation(database.query(
      `INSERT INTO price_snapshots
         (regional_product_id, amount_minor, currency, source, captured_at)
       VALUES ('missing-regional', 100, 'USD', 'official', $1)`,
      [invalidTime],
    ));
    await expectForeignKeyViolation(database.query(
      "INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES ('missing-regional', 'official', 'failed', $1)",
      [invalidTime],
    ));
    await expectForeignKeyViolation(database.query(
      "INSERT INTO regional_product_health (regional_product_id) VALUES ('missing-regional')",
    ));
    await expectForeignKeyViolation(database.query(
      `INSERT INTO notification_events
         (subscription_id, event_type, status, dedupe_key, created_at)
       VALUES ('missing-subscription', 'target-met', 'pending', 'bad-subscription-event', $1)`,
      [invalidTime],
    ));
    await expectForeignKeyViolation(database.query(
      `INSERT INTO notification_events
         (regional_product_id, event_type, status, dedupe_key, created_at)
       VALUES ('missing-regional', 'failure', 'pending', 'bad-regional-event', $1)`,
      [invalidTime],
    ));
  });

  it("由全部业务唯一约束拒绝并发重复数据", async () => {
    await seedConstraintParents(database);

    await expectUniqueViolation(database.query(
      `INSERT INTO games (id, name_zh, name_en, normalized_name, product_type, created_at)
       VALUES ('game-3', '游戏三', 'Game Three', 'game-one', 'base', $1)`,
      [fixedTime],
    ));
    await expectUniqueViolation(database.query(
      `INSERT INTO regional_products
         (id, game_id, region_code, currency, product_url, match_source, created_at)
       VALUES ('regional-3', 'game-1', 'JP', 'JPY', 'https://example.invalid/jp/duplicate', 'official', $1)`,
      [fixedTime],
    ));
    await expectUniqueViolation(database.query(
      "INSERT INTO subscriptions (id, game_id, created_at, updated_at) VALUES ('subscription-2', 'game-1', $1, $1)",
      [fixedTime],
    ));
    await expectUniqueViolation(database.query(
      "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ('subscription-1', 'regional-1')",
    ));
    await expectUniqueViolation(database.query(
      "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor) VALUES ('subscription-1', 'JP', 2500)",
    ));
    await expectUniqueViolation(database.query(
      "INSERT INTO exchange_rates (currency, cny_rate, source, captured_at) VALUES ('USD', 7.2, 'fixture-2', $1)",
      [fixedTime],
    ));
    await expectUniqueViolation(database.query(
      "INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES ('session-2', 'token-hash-1', $1, $2)",
      ["2026-08-05T08:00:00.000Z", fixedTime],
    ));
    await expectUniqueViolation(database.query(
      `INSERT INTO notification_events
         (event_type, status, dedupe_key, created_at)
       VALUES ('target-met', 'pending', 'dedupe-1', $1)`,
      [fixedTime],
    ));
  });

  it("保留限制删除、级联删除与解除诊断引用的破坏性边界", async () => {
    await seedConstraintParents(database);
    await database.query(
      `INSERT INTO price_snapshots
         (regional_product_id, amount_minor, currency, source, captured_at)
       VALUES ('regional-1', 4200, 'JPY', 'official', $1)`,
      [fixedTime],
    );
    await database.query(
      "INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES ('regional-2', 'official', 'failed', $1)",
      [fixedTime],
    );
    await database.query("INSERT INTO regional_product_health (regional_product_id) VALUES ('regional-2')");

    // 有价格历史或订阅映射的地区商品必须拒绝硬删除，防止失去价格来源与订阅审计链。
    await expectForeignKeyViolation(database.query("DELETE FROM regional_products WHERE id = 'regional-1'"));
    await database.query("DELETE FROM regional_products WHERE id = 'regional-2'");
    const detached = await database.query<{ regionalProductId: string | null }>(
      `SELECT regional_product_id AS "regionalProductId" FROM fetch_logs WHERE source = 'official'`,
    );
    expect(detached.rows).toEqual([{ regionalProductId: null }]);
    expect((await database.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM regional_product_health WHERE regional_product_id = 'regional-2'",
    )).rows[0].count).toBe("0");

    // 删除订阅只级联其选择与目标；通知事件必须保留审计记录但解除敏感业务引用。
    await database.query("DELETE FROM subscriptions WHERE id = 'subscription-1'");
    expect((await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM subscription_regions")).rows[0].count).toBe("0");
    expect((await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM subscription_region_targets")).rows[0].count).toBe("0");
    expect((await database.query<{ subscriptionId: string | null }>(
      `SELECT subscription_id AS "subscriptionId" FROM notification_events WHERE dedupe_key = 'dedupe-1'`,
    )).rows).toEqual([{ subscriptionId: null }]);
  });
});

describe("PostgreSQL 迁移执行器", () => {
  let database: AppDatabase;
  const temporaryDirectories: string[] = [];

  beforeAll(() => {
    database = createTestDatabase();
  });

  beforeEach(async () => {
    // checksum 与并发用例同样复用 fail-closed reset，避免后续重构绕过首次连接前的目标校验。
    await resetDisposableTestSchema(database);
  });

  afterAll(async () => {
    await database.close();
    // 只删除本测试通过 mkdtemp 创建的目录，绝不对工作区、用户目录或未解析路径执行递归清理。
    await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function createMigrationDirectory(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "switch-price-monitor-migrations-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "0001_probe.sql"), contents, "utf8");
    return directory;
  }

  it("按迁移表记录只应用一次完整模式与后续代理扩展", async () => {
    await runMigrations(database, migrationsDirectory);
    await runMigrations(database, migrationsDirectory);

    const applied = await database.query<{ version: string; count: string }>(
      `SELECT version, COUNT(*) AS count
         FROM schema_migrations
        GROUP BY version`,
    );
    // 迁移执行器必须同时记录初始模式与后续代理列扩展；重复运行只能校验 checksum，不能再次 ALTER 或遗漏版本。
    expect(applied.rows).toEqual(expect.arrayContaining([
      { version: "0001_initial.sql", count: "1" },
      { version: "0002_proxy_settings.sql", count: "1" },
    ]));
    expect((await database.query<{ tableName: string | null }>(
      "SELECT to_regclass('public.games')::text AS \"tableName\"",
    )).rows[0].tableName).toBe("games");
  });

  it("已应用迁移的精确字节发生变化时阻止启动", async () => {
    const directory = await createMigrationDirectory("CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);\n");
    await runMigrations(database, directory);

    // 即使 SQL 语义相近，历史文件的任何字节变化都必须触发 SHA-256 不匹配，禁止静默重写数据库历史。
    await writeFile(join(directory, "0001_probe.sql"), "CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);\n-- changed\n", "utf8");

    await expect(runMigrations(database, directory)).rejects.toThrow(/checksum/i);
  });

  it("并发 runner 通过同一 migration advisory lock 串行完成", async () => {
    const directory = await createMigrationDirectory(
      "SELECT pg_sleep(0.25);\nCREATE TABLE concurrent_probe (id INTEGER PRIMARY KEY);\n",
    );
    const contender = createTestDatabase();

    try {
      const first = runMigrations(database, directory);

      // 等到第一实例实际持有会话级 advisory lock 后再启动竞争者，排除仅靠启动时序碰巧串行的假阳性。
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const locks = await contender.query<{ count: string }>(
          "SELECT COUNT(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND granted",
        );
        if (locks.rows[0].count !== "0") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }

      const startedAt = performance.now();
      const second = runMigrations(contender, directory);
      await Promise.all([first, second]);
      const contenderElapsed = performance.now() - startedAt;

      expect(contenderElapsed).toBeGreaterThanOrEqual(150);
      expect((await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations")).rows[0].count).toBe("1");
    } finally {
      await contender.close();
    }
  });
});
