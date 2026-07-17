import { describe, expect, it, vi } from "vitest";

import { runSixHourCollection } from "../src/worker/services/scheduler-service";

describe("runSixHourCollection", () => {
  it("runs maintenance and one collection while consuming at most one queued manual refresh", async () => {
    // 无论是否有手动请求，六小时 Cron 只执行一次统一采集，避免“定时 + 手动”对任天堂产生重复外部请求。
    const retention = { cleanup: vi.fn().mockResolvedValue({ priceSnapshotsDeleted: 0, fetchLogsDeleted: 0 }) };
    const manualRefresh = { claimQueued: vi.fn().mockResolvedValue({ requestedAt: "2026-07-17T00:00:00.000Z" }) };
    const collection = { run: vi.fn().mockResolvedValue({ attempted: 2, collected: 2, stale: 0 }) };

    await expect(runSixHourCollection("2026-07-17T00:00:00.000Z", {
      settings: { get: async () => ({ priceHistoryRetention: "forever" as const }) },
      retention,
      manualRefresh,
      collection,
    })).resolves.toEqual({ kind: "collection-completed", manualRefreshConsumed: true });
    expect(retention.cleanup).toHaveBeenCalledTimes(1);
    expect(manualRefresh.claimQueued).toHaveBeenCalledTimes(1);
    expect(collection.run).toHaveBeenCalledTimes(1);
  });
});
