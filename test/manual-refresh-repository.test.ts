import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ManualRefreshRepository } from "../src/worker/repositories/manual-refresh-repository";

/**
 * 临时无冷却阶段的手动刷新仍只保留最近一次执行时间；测试覆盖连续请求都可进入采集，
 * 同时保证旧队列状态不会回归，以免生产数据库把时间记录误当成待 Cron 消费的任务。
 */
describe("ManualRefreshRepository temporary no cooldown", () => {
  beforeEach(async () => {
    // 单行最近刷新记录跨测试持久化；每例清空它可保证断言只由本用例的连续请求决定。
    await env.DB.exec("DELETE FROM manual_refresh_requests;");
  });

  it("accepts consecutive requests and keeps only the latest timestamp while cooldown is temporarily disabled", async () => {
    // 当前业务明确允许管理员连续触发真实采集；存储层仍只留下最后一次时间，避免无意义地积累浏览行为数据。
    const repository = new ManualRefreshRepository(env.DB);
    await expect(repository.request("2026-07-16T01:00:00.000Z")).resolves.toMatchObject({
      accepted: true,
      requestedAt: "2026-07-16T01:00:00.000Z",
      nextAllowedAt: "2026-07-16T01:00:00.000Z",
    });
    await expect(repository.request("2026-07-16T01:01:00.000Z")).resolves.toMatchObject({
      accepted: true,
      requestedAt: "2026-07-16T01:01:00.000Z",
      nextAllowedAt: "2026-07-16T01:01:00.000Z",
    });
    await expect(env.DB.prepare("SELECT requested_at AS requestedAt FROM manual_refresh_requests WHERE id = 1").first())
      .resolves.toEqual({ requestedAt: "2026-07-16T01:01:00.000Z" });
  });

  it("stores no queued or running status after the immediate-refresh migration", async () => {
    // 旧状态列会让实现者误把立即刷新再次接回 Cron 队列；只保留时间戳才能表达最近操作而非待执行任务。
    const columns = await env.DB.prepare("PRAGMA table_info(manual_refresh_requests)").all<{ name: string }>();

    expect(columns.results.map((column) => column.name)).toEqual(["id", "requested_at"]);
  });
});
