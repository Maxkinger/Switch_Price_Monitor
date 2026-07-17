import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ManualRefreshRepository } from "../src/worker/repositories/manual-refresh-repository";

/**
 * 手动刷新迁移后只保留最近一次执行时间，测试同时覆盖原子冷却和旧队列状态的彻底移除。
 * 这样生产数据库不会把历史 queued 记录误认作仍需等待 Cron 的任务。
 */
describe("ManualRefreshRepository cooldown", () => {
  beforeEach(async () => {
    // 单行冷却记录跨测试持久化；每例清空它可保证并发断言只由本用例两个请求决定。
    await env.DB.exec("DELETE FROM manual_refresh_requests;");
  });

  it("accepts one timestamp and rejects a concurrent request until the fifteen-minute cutoff", async () => {
    // 两个实例模拟重叠的管理员请求；数据库 UPSERT 而非前端禁用必须决定唯一可执行名额。
    const first = new ManualRefreshRepository(env.DB);
    const second = new ManualRefreshRepository(env.DB);
    const [firstResult, secondResult] = await Promise.all([
      first.request("2026-07-16T01:00:00.000Z"),
      second.request("2026-07-16T01:00:00.000Z"),
    ]);

    expect([firstResult, secondResult].filter((result) => result.accepted)).toHaveLength(1);
    await expect(env.DB.prepare("SELECT requested_at AS requestedAt FROM manual_refresh_requests WHERE id = 1").first())
      .resolves.toEqual({ requestedAt: "2026-07-16T01:00:00.000Z" });
    await expect(first.request("2026-07-16T01:10:00.000Z")).resolves.toMatchObject({
      accepted: false,
      nextAllowedAt: "2026-07-16T01:15:00.000Z",
    });
  });

  it("stores no queued or running status after the immediate-refresh migration", async () => {
    // 旧状态列会让实现者误把立即刷新再次接回 Cron 队列；只保留时间戳才能表达冷却而非待执行任务。
    const columns = await env.DB.prepare("PRAGMA table_info(manual_refresh_requests)").all<{ name: string }>();

    expect(columns.results.map((column) => column.name)).toEqual(["id", "requested_at"]);
  });
});
