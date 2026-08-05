import {
  appendFile,
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import { createPostgresDatabase } from "../src/server/database/pool";
import type { AppDatabase, SqlExecutor } from "../src/server/database/types";
import {
  POSTGRES_MIGRATION_DIRECTORY,
  requireTestDatabaseUrl,
  resetTestSchema,
} from "./support/postgres";

const expectedTables = [
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
];

const expectedBusinessIndexes = [
  "games_normalized_name_unique",
  "idx_fetch_logs_captured_at",
  "idx_price_snapshots_product_captured",
];

describe("PostgreSQL 初始 schema", () => {
  let database: AppDatabase;

  beforeAll(() => {
    database = createPostgresDatabase(requireTestDatabaseUrl());
  });

  beforeEach(async () => {
    // 每例从空 public schema 应用真实迁移，防止约束拒绝测试留下的数据影响下一例。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
  });

  afterAll(async () => {
    await database.close();
  });

  it("创建全部业务表、迁移表和查询所需显式索引", async () => {
    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1::text[])
      ORDER BY indexname
    `, [expectedBusinessIndexes]);

    expect(tables.rows.map((row) => row.table_name)).toEqual(expectedTables);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expectedBusinessIndexes);
  });

  it("从空库完成全部迁移后使用 Compose 预建的普通应用角色", async () => {
    const role = await database.query<{
      role_name: string;
      is_superuser: boolean;
      can_create_role: boolean;
      can_create_database: boolean;
      can_replicate: boolean;
      can_bypass_rls: boolean;
    }>(`
      SELECT
        current_user AS role_name,
        rolsuper AS is_superuser,
        rolcreaterole AS can_create_role,
        rolcreatedb AS can_create_database,
        rolreplication AS can_replicate,
        rolbypassrls AS can_bypass_rls
      FROM pg_roles
      WHERE rolname = current_user
    `);

    /**
     * Compose init hook 用独立 bootstrap 管理角色创建 switch_test；应用迁移从第一条 SQL 起就不得拥有集群级能力。
     * 测试 URL 保持普通角色，既验证生产双角色模型，也避免测试辅助 DROP SCHEMA 获得跨数据库权限。
     */
    expect(role.rows).toEqual([
      {
        role_name: "switch_test",
        is_superuser: false,
        can_create_role: false,
        can_create_database: false,
        can_replicate: false,
        can_bypass_rls: false,
      },
    ]);
  });

  it("把布尔、时间、JSON、身份主键和整数金额映射为 PostgreSQL 原生类型", async () => {
    const columns = await database.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_identity: "YES" | "NO";
    }>(`
      SELECT table_name, column_name, data_type, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('settings', 'enabled_regions_json'),
          ('regional_products', 'enabled'),
          ('subscriptions', 'enabled'),
          ('exchange_rates', 'is_stale'),
          ('regional_product_health', 'failure_notified'),
          ('games', 'created_at'),
          ('sessions', 'expires_at'),
          ('price_snapshots', 'captured_at'),
          ('price_snapshots', 'id'),
          ('exchange_rates', 'id'),
          ('fetch_logs', 'id'),
          ('notification_events', 'id'),
          ('price_snapshots', 'amount_minor'),
          ('price_snapshots', 'cny_fen'),
          ('subscriptions', 'global_target_cny_fen'),
          ('subscription_region_targets', 'target_amount_minor')
        )
      ORDER BY table_name, column_name
    `);

    expect(columns.rows).toEqual([
      { table_name: "exchange_rates", column_name: "id", data_type: "bigint", is_identity: "YES" },
      { table_name: "exchange_rates", column_name: "is_stale", data_type: "boolean", is_identity: "NO" },
      { table_name: "fetch_logs", column_name: "id", data_type: "bigint", is_identity: "YES" },
      { table_name: "games", column_name: "created_at", data_type: "timestamp with time zone", is_identity: "NO" },
      { table_name: "notification_events", column_name: "id", data_type: "bigint", is_identity: "YES" },
      { table_name: "price_snapshots", column_name: "amount_minor", data_type: "integer", is_identity: "NO" },
      { table_name: "price_snapshots", column_name: "captured_at", data_type: "timestamp with time zone", is_identity: "NO" },
      { table_name: "price_snapshots", column_name: "cny_fen", data_type: "integer", is_identity: "NO" },
      { table_name: "price_snapshots", column_name: "id", data_type: "bigint", is_identity: "YES" },
      { table_name: "regional_product_health", column_name: "failure_notified", data_type: "boolean", is_identity: "NO" },
      { table_name: "regional_products", column_name: "enabled", data_type: "boolean", is_identity: "NO" },
      { table_name: "sessions", column_name: "expires_at", data_type: "timestamp with time zone", is_identity: "NO" },
      { table_name: "settings", column_name: "enabled_regions_json", data_type: "jsonb", is_identity: "NO" },
      { table_name: "subscription_region_targets", column_name: "target_amount_minor", data_type: "integer", is_identity: "NO" },
      { table_name: "subscriptions", column_name: "enabled", data_type: "boolean", is_identity: "NO" },
      { table_name: "subscriptions", column_name: "global_target_cny_fen", data_type: "integer", is_identity: "NO" },
    ]);

    const nonTimestampTimeColumns = await database.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name LIKE '%\\_at' ESCAPE '\\' OR column_name = 'locked_until')
        AND data_type <> 'timestamp with time zone'
      ORDER BY table_name, column_name
    `);
    // 所有业务时间、过期时间、锁定时间和迁移时间都必须带时区；空结果可捕获任一列误退回 TEXT 或 TIMESTAMP。
    expect(nonTimestampTimeColumns.rows).toEqual([]);
  });

  it("每个既有外键都拒绝不存在的父记录", async () => {
    const invalidForeignKeyStatements: Array<[string, readonly unknown[]]> = [
      [
        "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ($1, $2, 'US', 'USD', 'https://example.test/us', 'test')",
        ["invalid-product", "missing-game"],
      ],
      [
        "INSERT INTO subscriptions (id, game_id) VALUES ($1, $2)",
        ["invalid-subscription", "missing-game"],
      ],
      [
        "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ($1, $2)",
        ["missing-subscription", "missing-product"],
      ],
      [
        "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor) VALUES ($1, 'JP', 100)",
        ["missing-subscription"],
      ],
      [
        "INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at) VALUES ($1, 100, 'USD', 'official', CURRENT_TIMESTAMP)",
        ["missing-product"],
      ],
      [
        "INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES ($1, 'official', 'failed', CURRENT_TIMESTAMP)",
        ["missing-product"],
      ],
      [
        "INSERT INTO regional_product_health (regional_product_id) VALUES ($1)",
        ["missing-product"],
      ],
      [
        "INSERT INTO notification_events (subscription_id, event_type, status, dedupe_key) VALUES ($1, 'price-drop', 'pending', 'invalid-subscription-event')",
        ["missing-subscription"],
      ],
      [
        "INSERT INTO notification_events (regional_product_id, event_type, status, dedupe_key) VALUES ($1, 'price-drop', 'pending', 'invalid-product-event')",
        ["missing-product"],
      ],
    ];

    for (const [sql, parameters] of invalidForeignKeyStatements) {
      await expect(database.query(sql, parameters)).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("保留所有单例、状态和业务唯一约束", async () => {
    await insertCoreFixture(database);

    const duplicateOrInvalidStatements: Array<[string, readonly unknown[], string]> = [
      [
        "INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at) VALUES (2, '[]'::jsonb, 'US', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        [],
        "23514",
      ],
      [
        "INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source) VALUES ('product-duplicate-region', 'game-a', 'US', 'USD', 'https://example.test/duplicate', 'test')",
        [],
        "23505",
      ],
      [
        "INSERT INTO subscriptions (id, game_id) VALUES ('subscription-duplicate-game', 'game-a')",
        [],
        "23505",
      ],
      [
        "INSERT INTO games (id, name_zh, name_en, normalized_name, product_type) VALUES ('game-duplicate-normalized', '重复', 'Duplicate', 'game-a|publisher|game', 'game')",
        [],
        "23505",
      ],
      [
        "INSERT INTO subscription_regions (subscription_id, regional_product_id) VALUES ('subscription-a', 'product-a-us')",
        [],
        "23505",
      ],
      [
        "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor) VALUES ('subscription-a', 'US', 200)",
        [],
        "23505",
      ],
      [
        "INSERT INTO exchange_rates (currency, cny_rate, source, captured_at) VALUES ('USD', 7.1, 'duplicate', '2026-07-27T00:00:00Z')",
        [],
        "23505",
      ],
      [
        "INSERT INTO sessions (id, token_hash, expires_at, created_at) VALUES ('session-b', 'token-hash-a', '2026-07-28T00:00:00Z', '2026-07-27T00:00:00Z')",
        [],
        "23505",
      ],
      [
        "INSERT INTO notification_events (event_type, status, dedupe_key) VALUES ('price-drop', 'pending', 'event-a')",
        [],
        "23505",
      ],
      [
        "INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor, target_state) VALUES ('subscription-a', 'JP', 100, 'invalid')",
        [],
        "23514",
      ],
      [
        "INSERT INTO admin_credentials (id, password_hash, password_salt, recovery_hash, recovery_salt, created_at) VALUES (2, 'hash', 'salt', 'recovery', 'salt', CURRENT_TIMESTAMP)",
        [],
        "23514",
      ],
      [
        "INSERT INTO login_attempts (id) VALUES (2)",
        [],
        "23514",
      ],
      [
        "INSERT INTO manual_refresh_requests (id, requested_at) VALUES (2, CURRENT_TIMESTAMP)",
        [],
        "23514",
      ],
    ];

    for (const [sql, parameters, code] of duplicateOrInvalidStatements) {
      await expect(database.query(sql, parameters)).rejects.toMatchObject({ code });
    }
  });

  it("按既有 RESTRICT、CASCADE 与 SET NULL 规则执行破坏性删除", async () => {
    await insertCoreFixture(database);
    await database.query(
      "INSERT INTO price_snapshots (regional_product_id, amount_minor, currency, source, captured_at) VALUES ('product-a-us', 999, 'USD', 'official', CURRENT_TIMESTAMP)",
    );
    await database.query(
      "INSERT INTO fetch_logs (regional_product_id, source, status, captured_at) VALUES ('product-a-us', 'official', 'ok', CURRENT_TIMESTAMP)",
    );
    await database.query(
      "INSERT INTO regional_product_health (regional_product_id) VALUES ('product-a-us')",
    );

    await expect(database.query("DELETE FROM games WHERE id = 'game-a'")).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      database.query("DELETE FROM regional_products WHERE id = 'product-a-us'"),
    ).rejects.toMatchObject({ code: "23503" });

    // 删除订阅只级联其地区关系和目标，通知审计保留但解除订阅引用，防止历史事件被级联抹除。
    await database.query("DELETE FROM subscriptions WHERE id = 'subscription-a'");
    const subscriptionDependents = await database.query<{
      regions: string;
      targets: string;
      notification_subscription_id: string | null;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM subscription_regions)::text AS regions,
        (SELECT COUNT(*) FROM subscription_region_targets)::text AS targets,
        (SELECT subscription_id FROM notification_events WHERE dedupe_key = 'event-a') AS notification_subscription_id
    `);
    expect(subscriptionDependents.rows[0]).toEqual({
      regions: "0",
      targets: "0",
      notification_subscription_id: null,
    });

    // 清除受 RESTRICT 保护的价格后才允许删除地区商品；日志/通知置空，健康状态级联清理。
    await database.query("DELETE FROM price_snapshots WHERE regional_product_id = 'product-a-us'");
    await database.query("DELETE FROM regional_products WHERE id = 'product-a-us'");
    const productDependents = await database.query<{
      log_product_id: string | null;
      event_product_id: string | null;
      health_count: string;
    }>(`
      SELECT
        (SELECT regional_product_id FROM fetch_logs LIMIT 1) AS log_product_id,
        (SELECT regional_product_id FROM notification_events WHERE dedupe_key = 'event-a') AS event_product_id,
        (SELECT COUNT(*) FROM regional_product_health)::text AS health_count
    `);
    expect(productDependents.rows[0]).toEqual({
      log_product_id: null,
      event_product_id: null,
      health_count: "0",
    });
  });
});

describe("PostgreSQL 迁移运行器", () => {
  let database: AppDatabase;

  beforeAll(() => {
    database = createPostgresDatabase(requireTestDatabaseUrl());
  });

  beforeEach(async () => {
    await resetTestSchema(database);
  });

  afterAll(async () => {
    await database.close();
  });

  it("重复运行完整迁移集时每个版本只记录和应用一次", async () => {
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);

    /**
     * 迁移目录是版本集合的唯一权威来源：不能把首个 0001 文件误当成总数，也不能因新增安全迁移
     * 而放宽“每个文件仅一条账本记录”的幂等性保证。只统计当前目录第一层常规 SQL 文件，
     * 与运行器的发现边界保持一致，避免临时目录或编辑器文件影响数据库升级结论。
     */
    const expectedVersions = (await readdir(POSTGRES_MIGRATION_DIRECTORY, {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
    const result = await database.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(result.rows.map((row) => row.version)).toEqual(expectedVersions);
  });

  it("已应用迁移的精确字节变化时以 SHA-256 不匹配阻止启动", async () => {
    const temporaryDirectory = await createTemporaryMigrationDirectory();
    const version = "0001_initial.sql";
    try {
      await copyFile(
        join(POSTGRES_MIGRATION_DIRECTORY, version),
        join(temporaryDirectory, version),
      );
      await runMigrations(database, temporaryDirectory);
      // 即使只追加注释也会改变精确字节哈希；历史迁移不可被“无功能变化”理由静默改写。
      await appendFile(join(temporaryDirectory, version), "\n-- 测试篡改字节\n", "utf8");

      await expect(runMigrations(database, temporaryDirectory)).rejects.toThrow(
        /0001_initial\.sql.*SHA-256/,
      );
    } finally {
      await removeTemporaryMigrationDirectory(temporaryDirectory);
    }
  });

  it("并发运行器等待专用迁移锁后继续应用新增版本", async () => {
    const temporaryRoot = await createTemporaryMigrationDirectory();
    const firstDirectory = join(temporaryRoot, "first");
    const secondDirectory = join(temporaryRoot, "second");
    const sharedInitialSql = `
      SELECT pg_sleep(0.25);
      CREATE TABLE migration_serialization_probe (id INTEGER PRIMARY KEY);
    `;
    await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
    await Promise.all([
      writeFile(join(firstDirectory, "0001_serial.sql"), sharedInitialSql, "utf8"),
      writeFile(join(secondDirectory, "0001_serial.sql"), sharedInitialSql, "utf8"),
      writeFile(
        join(secondDirectory, "0002_after_wait.sql"),
        "CREATE TABLE migration_after_wait_probe (id INTEGER PRIMARY KEY);",
        "utf8",
      ),
    ]);

    const firstDatabase = createPostgresDatabase(requireTestDatabaseUrl());
    const secondDatabase = createPostgresDatabase(requireTestDatabaseUrl());
    try {
      const firstRun = runMigrations(firstDatabase, firstDirectory);
      // schema_migrations 由持锁运行器创建；观察到它即可确定第二运行器是在第一把锁存续期间开始竞争。
      await waitForMigrationTable(database);
      const secondRun = runMigrations(secondDatabase, secondDirectory);
      await Promise.all([firstRun, secondRun]);

      const versions = await database.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      const secondTable = await database.query<{ exists: string | null }>(
        "SELECT to_regclass('public.migration_after_wait_probe')::text AS exists",
      );
      expect(versions.rows).toEqual([
        { version: "0001_serial.sql" },
        { version: "0002_after_wait.sql" },
      ]);
      expect(secondTable.rows[0].exists).toBe("migration_after_wait_probe");
    } finally {
      await Promise.all([firstDatabase.close(), secondDatabase.close()]);
      await removeTemporaryMigrationDirectory(temporaryRoot);
    }
  });
});

/**
 * 插入覆盖全部唯一键和删除关系的最小业务图。所有 URL、哈希和时间都是固定测试数据，
 * 不包含真实管理员凭据、会话令牌、价格来源响应或 Telegram 配置。
 */
async function insertCoreFixture(database: SqlExecutor): Promise<void> {
  await database.query(`
    INSERT INTO settings (id, enabled_regions_json, default_search_region, created_at, updated_at)
    VALUES (1, '["US"]'::jsonb, 'US', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO games (id, name_zh, name_en, normalized_name, product_type)
    VALUES ('game-a', '测试游戏', 'Test Game', 'game-a|publisher|game', 'game');
    INSERT INTO regional_products (id, game_id, region_code, currency, product_url, match_source)
    VALUES ('product-a-us', 'game-a', 'US', 'USD', 'https://example.test/us', 'test');
    INSERT INTO subscriptions (id, game_id) VALUES ('subscription-a', 'game-a');
    INSERT INTO subscription_regions (subscription_id, regional_product_id)
    VALUES ('subscription-a', 'product-a-us');
    INSERT INTO subscription_region_targets (subscription_id, region_code, target_amount_minor)
    VALUES ('subscription-a', 'US', 100);
    INSERT INTO exchange_rates (currency, cny_rate, source, captured_at)
    VALUES ('USD', 7.0, 'test', '2026-07-27T00:00:00Z');
    INSERT INTO sessions (id, token_hash, expires_at, created_at)
    VALUES ('session-a', 'token-hash-a', '2026-07-28T00:00:00Z', '2026-07-27T00:00:00Z');
    INSERT INTO notification_events (
      subscription_id, regional_product_id, event_type, status, dedupe_key
    ) VALUES (
      'subscription-a', 'product-a-us', 'price-drop', 'pending', 'event-a'
    );
  `);
}

/**
 * 创建带固定安全前缀的系统临时目录，测试只会在此目录复制或生成迁移文件，
 * 不修改仓库中的权威迁移，也不接触用户文档和数据库持久卷。
 */
async function createTemporaryMigrationDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "switch-price-monitor-task2-migrations-"));
}

/**
 * 递归清理前再次核验由 mkdtemp 生成的目录名，防止路径计算错误扩大删除范围。
 * 此辅助函数只处理测试迁移副本；正式迁移文件和数据库备份永远不通过它删除。
 */
async function removeTemporaryMigrationDirectory(directory: string): Promise<void> {
  if (!basename(directory).startsWith("switch-price-monitor-task2-migrations-")) {
    throw new Error("拒绝清理不属于 Task 2 的临时迁移目录");
  }
  await rm(directory, { recursive: true });
}

/**
 * 轮询迁移表出现，作为第一运行器已进入专用锁临界区的可观察信号。
 * 设定一秒硬上限避免数据库异常时测试无限等待；不读取锁键或其他项目会话。
 */
async function waitForMigrationTable(database: SqlExecutor): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const result = await database.query<{ exists: string | null }>(
      "SELECT to_regclass('public.schema_migrations')::text AS exists",
    );
    if (result.rows[0].exists === "schema_migrations") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待第一迁移运行器取得锁超时");
}
