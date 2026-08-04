import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ManualRefreshRepository } from "../src/repositories/postgres/manual-refresh-repository";
import { runMigrations } from "../src/server/database/migrations";
import { createTestDatabase, resetDisposableTestSchema } from "./support/postgres";

/**
 * 临时无冷却阶段的 PostgreSQL 仓储仍只保留最近一次请求时间。
 * 测试使用正式 TIMESTAMPTZ 与单例约束，确保并发管理员请求不会令时间倒退，也不会恢复旧 queued/running 队列语义。
 */
describe("PostgreSQL ManualRefreshRepository temporary no cooldown", () => {
  // destructive setup 只允许固定回环端口、专用用户/数据库和显式 marker 的 disposable PostgreSQL。
  const database = createTestDatabase();
  const repository = new ManualRefreshRepository(database);

  beforeAll(async () => {
    // 正式迁移确保测试观察的列、TIMESTAMPTZ 和单例主键与 NAS 新数据库完全一致。
    await resetDisposableTestSchema(database);
    await runMigrations(database, resolve("migrations/postgres"));
  });

  beforeEach(async () => {
    // 单行最近时刻跨请求持久化；每例清空后只由本用例的连续或并发请求决定最终状态。
    await database.query("TRUNCATE manual_refresh_requests RESTART IDENTITY");
  });

  afterAll(async () => {
    // 释放连接池，避免下一个 PostgreSQL 文件重建 disposable schema 时仍有旧连接占用。
    await database.close();
  });

  it("accepts consecutive requests and keeps only the latest timestamp while cooldown is disabled", async () => {
    // 当前业务明确允许管理员连续触发采集；仓储只记录最后时刻，不收集管理员、会话、商品或来源响应。
    await expect(repository.request("2026-07-16T01:00:00.000Z")).resolves.toEqual({
      accepted: true,
      requestedAt: "2026-07-16T01:00:00.000Z",
      nextAllowedAt: "2026-07-16T01:00:00.000Z",
    });
    await expect(repository.request("2026-07-16T01:01:00.000Z")).resolves.toEqual({
      accepted: true,
      requestedAt: "2026-07-16T01:01:00.000Z",
      nextAllowedAt: "2026-07-16T01:01:00.000Z",
    });
    await expect(readRequestedAt()).resolves.toBe("2026-07-16T01:01:00.000Z");
  });

  it("does not let an older concurrent request overwrite a newer timestamp", async () => {
    // 两个 Node 请求可能以任意顺序取得连接和提交；GREATEST 必须让数据库事实保持最大绝对时刻，而非最后完成的调用参数。
    await Promise.all([
      repository.request("2026-07-16T02:00:00.000Z"),
      repository.request("2026-07-16T01:30:00.000Z"),
    ]);

    await expect(readRequestedAt()).resolves.toBe("2026-07-16T02:00:00.000Z");
  });

  it("stores no queued or running status after the immediate-refresh migration", async () => {
    // 旧状态列会让实现者误把同步刷新再次接回调度队列；正式表只能保留固定 id 和 requested_at。
    const columns = await database.query<{ name: string }>(
      `SELECT column_name AS name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'manual_refresh_requests'
        ORDER BY ordinal_position ASC`,
    );

    expect(columns.rows.map((column) => column.name)).toEqual(["id", "requested_at"]);
  });

  /** 将 pg Date 统一转换为 UTC ISO，测试不依赖运行测试的 Mac/NAS 本地时区。 */
  async function readRequestedAt(): Promise<string> {
    const result = await database.query<{ requestedAt: Date }>(
      `SELECT requested_at AS "requestedAt"
         FROM manual_refresh_requests
        WHERE id = 1`,
    );
    const value = result.rows[0]?.requestedAt;
    if (!value) throw new Error("测试最近刷新时间缺失。");
    return value.toISOString();
  }
});
