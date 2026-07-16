import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ManualRefreshRepository } from "../src/worker/repositories/manual-refresh-repository";

describe("ManualRefreshRepository queue claiming", () => {
  beforeEach(async () => {
    // 单行队列跨测试持久化；每例清空它可验证本次认领结果仅由用例中的管理员请求产生。
    await env.DB.exec("DELETE FROM manual_refresh_requests;");
  });

  it("atomically lets only one concurrent scheduler claim a queued manual refresh", async () => {
    // 两个独立仓储实例模拟 Cloudflare 可能重叠的 Cron 执行；只能有一个取得请求，避免同一手动操作重复访问外部价格来源。
    const firstScheduler = new ManualRefreshRepository(env.DB);
    const secondScheduler = new ManualRefreshRepository(env.DB);
    await firstScheduler.request("2026-07-16T01:00:00.000Z");

    const claims = await Promise.all([firstScheduler.claimQueued(), secondScheduler.claimQueued()]);
    const successfulClaims = claims.filter((claim): claim is { requestedAt: string } => claim !== null);

    expect(successfulClaims).toEqual([{ requestedAt: "2026-07-16T01:00:00.000Z" }]);
    await expect(env.DB.prepare("SELECT status FROM manual_refresh_requests WHERE id = 1").first<{ status: string }>()).resolves.toEqual({ status: "running" });
  });
});
