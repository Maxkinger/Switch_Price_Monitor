import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/server/database/migrations";
import { createPostgresDatabase } from "../src/server/database/pool";
import type { AppDatabase } from "../src/server/database/types";
import { PostgresGameNameRepository } from "../src/repositories/postgres/game-name-repository";
import {
  POSTGRES_MIGRATION_DIRECTORY,
  requireTestDatabaseUrl,
  resetTestSchema,
} from "./support/postgres";

describe("游戏简体中文名称词条存储", () => {
  let database: AppDatabase;

  beforeAll(() => {
    database = createPostgresDatabase(requireTestDatabaseUrl());
  });

  beforeEach(async () => {
    // 每例均从空库执行权威迁移，确保词条主键是数据库级并发裁决，而非测试或应用层的偶然行为。
    await resetTestSchema(database);
    await runMigrations(database, POSTGRES_MIGRATION_DIRECTORY);
  });

  afterAll(async () => {
    await database.close();
  });

  it("按精确规范化身份唯一保存已确认的中文展示词条", async () => {
    // identity_key 的竖线分隔值与现有 games.normalized_name 精确对应；名称仅供展示，不能借相似标题合并不同发行商或商品类型。
    const now = "2026-08-10T00:00:00.000Z";
    const identityKey = "overcooked 2|ghost town games|game";

    await database.query(
      "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
      [identityKey, "胡闹厨房 2", "publisher", now],
    );

    await expect(database.query(
      "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
      [identityKey, "错误重复名", "manual", now],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("拒绝不在受控白名单内的词条来源", async () => {
    // 来源白名单是展示名称审计边界：未被批准的抓取器或任意客户端标签不得伪装成可回填的中文名称。
    await expect(database.query(
      "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
      ["invalid-source|publisher|game", "测试名称", "unverified-crawler", "2026-08-10T00:00:00.000Z"],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["publisher", "publisher-source|publisher|game"],
    ["mainland-platform", "mainland-platform-source|publisher|game"],
    ["hk-reference", "hk-reference-source|publisher|game"],
    ["manual", "manual-source|publisher|game"],
  ])("允许白名单来源 %s 保存词条", async (source, identityKey) => {
    // 每个来源都必须单独成功，避免约束未来被错误收窄而只保留 publisher/manual 时，非法来源的拒绝测试仍给出假阳性。
    await database.query(
      "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
      [identityKey, `来源 ${source} 的测试名称`, source, "2026-08-10T00:00:00.000Z"],
    );
  });

  it.each([
    ["blank-name|publisher|game", "   "],
    ["overlong-name|publisher|game", "名".repeat(121)],
  ])("拒绝修剪后不在 1 到 120 字符范围内的词条名称：%s", async (identityKey, displayNameZhCn) => {
    // trim 后长度是展示安全边界；空白名称会制造空主标题，超长名称会破坏管理界面且不应依赖调用方自行截断。
    await expect(database.query(
      "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4)",
      [identityKey, displayNameZhCn, "manual", "2026-08-10T00:00:00.000Z"],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("允许修剪后长度恰为 1 与 120 的词条名称", async () => {
    // 两端边界必须可保存，避免未来把长度条件误收紧后仅保留拒绝用例而漏报合法的人工确认名称。
    await database.query(
      "INSERT INTO game_name_catalog (identity_key, display_name_zh_cn, source, confirmed_at) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)",
      [
        "short-name|publisher|game", "名", "publisher", "2026-08-10T00:00:00.000Z",
        "maximum-name|publisher|game", "名".repeat(120), "manual", "2026-08-10T00:00:00.000Z",
      ],
    );
  });

  it("目录回填首次更新空名称游戏，重复执行不再更新", async () => {
    // normalized_name 对逻辑游戏全局唯一；本例只建立一个 pending 游戏，测量首次命中与第二次幂等而不构造生产中不可能存在的重复身份夹具。
    const repository = new PostgresGameNameRepository(database);
    const now = "2026-08-10T00:00:00.000Z";
    const identityKey = "overcooked 2|ghost town games|game";
    await seedGame(database, "game-pending", "subscription-pending", identityKey, null, null, null, now);
    await database.query(
      `INSERT INTO game_name_catalog (
         identity_key, display_name_zh_cn, source, evidence_url, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [identityKey, "胡闹厨房 2", "publisher", "https://example.com/overcooked-2", now],
    );

    expect(await repository.applyCatalogBackfill(now)).toEqual({
      updatedGameIds: ["game-pending"],
      remainingCount: 0,
    });
    expect(await repository.applyCatalogBackfill("2026-08-10T01:00:00.000Z")).toEqual({
      updatedGameIds: [],
      remainingCount: 0,
    });
  });

  it("目录回填不会改写已有人工确认名称", async () => {
    // 独立案例在 beforeEach 后只有一个 manual 游戏使用该身份；若 UPDATE 漏掉空名称条件，会直接把人工值和来源覆写为 catalog。
    const repository = new PostgresGameNameRepository(database);
    const now = "2026-08-10T00:00:00.000Z";
    const identityKey = "overcooked 2|ghost town games|game";
    await seedGame(database, "game-manual", "subscription-manual", identityKey, "人工核对名称", "manual", now, now);
    await database.query(
      `INSERT INTO game_name_catalog (
         identity_key, display_name_zh_cn, source, evidence_url, confirmed_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [identityKey, "胡闹厨房 2", "publisher", "https://example.com/overcooked-2", now],
    );

    expect(await repository.applyCatalogBackfill(now)).toEqual({
      updatedGameIds: [],
      remainingCount: 0,
    });
    await expect(database.query<{ displayName: string; source: string }>(
      `SELECT display_name_zh_cn AS "displayName", display_name_source AS "source"
         FROM games
        WHERE id = $1`,
      ["game-manual"],
    )).resolves.toMatchObject({ rows: [{ displayName: "人工核对名称", source: "manual" }] });
  });

  it("可按游戏 ID 读取已确认游戏的精确身份而不依赖展示状态", async () => {
    // 详情页名称纠错发生在 display_name_zh_cn 已非空之后；若查询继续带 pending 条件，会把真实游戏误判为不存在并阻断安全更正。
    const repository = new PostgresGameNameRepository(database);
    const now = "2026-08-10T00:00:00.000Z";
    const identityKey = "overcooked 2|ghost town games|game";
    await seedGame(database, "game-confirmed-lookup", "subscription-confirmed-lookup", identityKey, "胡闹厨房 2", "manual", now, now);

    await expect(repository.findGameIdentity("game-confirmed-lookup")).resolves.toEqual({ identityKey });
  });

  it("可更正已确认游戏并写入目录，且不会把该游戏重新列为 pending", async () => {
    // 这条真实 PostgreSQL 回归同时保护详情页更正与未来建议：更新应保留当前游戏 manual 状态，目录只按既有精确 identityKey 建立，
    // listPending 仍只表达空展示名待办，不能因为目录写入或已有游戏更正而重新出现已确认 ID。
    const repository = new PostgresGameNameRepository(database);
    const now = "2026-08-10T00:00:00.000Z";
    const correctedAt = "2026-08-10T01:00:00.000Z";
    const identityKey = "overcooked 2|ghost town games|game";
    await seedGame(database, "game-confirmed-save", "subscription-confirmed-save", identityKey, "胡闹厨房 2（旧译）", "manual", now, now);

    await repository.saveGameName({
      gameId: "game-confirmed-save",
      identityKey,
      displayNameZhCn: "胡闹厨房 2：美食家版",
      source: "publisher",
      evidenceUrl: "https://example.com/overcooked-2-gourmet",
      saveToCatalog: true,
      confirmedAt: correctedAt,
    });

    await expect(database.query<{ displayName: string; source: string; confirmedAt: Date }>(
      `SELECT display_name_zh_cn AS "displayName",
              display_name_source AS "source",
              display_name_confirmed_at AS "confirmedAt"
         FROM games
        WHERE id = $1`,
      ["game-confirmed-save"],
    )).resolves.toMatchObject({
      rows: [{ displayName: "胡闹厨房 2：美食家版", source: "manual", confirmedAt: new Date(correctedAt) }],
    });
    await expect(repository.findCatalogEntry(identityKey)).resolves.toMatchObject({
      displayNameZhCn: "胡闹厨房 2：美食家版",
      source: "publisher",
      evidenceUrl: "https://example.com/overcooked-2-gourmet",
      confirmedAt: correctedAt,
    });
    await expect(repository.listPending()).resolves.toEqual([]);
  });
});

/**
 * 构造受迁移约束保护的最小游戏与订阅记录，供仓储验证回填的真实 SQL 效果。
 * 只使用合成 ID、公开标题和 example 域名，不接触网络或认证材料，避免集成测试越过一次性数据库边界。
 */
async function seedGame(
  database: AppDatabase,
  gameId: string,
  subscriptionId: string,
  identityKey: string,
  displayNameZhCn: string | null,
  displayNameSource: "catalog" | "manual" | null,
  confirmedAt: string | null,
  now: string,
): Promise<void> {
  await database.query(
    `INSERT INTO games (
       id, name_zh, name_en, normalized_name, publisher, product_type, created_at,
       display_name_zh_cn, display_name_source, display_name_confirmed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      gameId,
      "Overcooked! 2",
      "Overcooked! 2",
      identityKey,
      "Ghost Town Games",
      "game",
      now,
      displayNameZhCn,
      displayNameSource,
      confirmedAt,
    ],
  );
  await database.query(
    `INSERT INTO subscriptions (id, game_id, enabled, created_at, updated_at)
     VALUES ($1, $2, TRUE, $3, $3)`,
    [subscriptionId, gameId, now],
  );
}
