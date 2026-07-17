import { describe, expect, it, vi } from "vitest";

import { runSixHourCollection } from "../src/worker/services/scheduler-service";

describe("runSixHourCollection", () => {
  it("runs maintenance and one collection without reading manual refresh state", async () => {
    // 手动刷新已在 HTTP 请求内完成；六小时 Cron 只负责固定自动采集，不能再读取或认领任何旧队列状态。
    const retention = { cleanup: vi.fn().mockResolvedValue({ priceSnapshotsDeleted: 0, fetchLogsDeleted: 0 }) };
    const collection = { run: vi.fn().mockResolvedValue({ attempted: 2, collected: 2, stale: 0 }) };

    await expect(runSixHourCollection("2026-07-17T00:00:00.000Z", {
      settings: { get: async () => ({ priceHistoryRetention: "forever" as const }) },
      retention,
      collection,
    })).resolves.toEqual({ kind: "collection-completed" });
    expect(retention.cleanup).toHaveBeenCalledTimes(1);
    expect(collection.run).toHaveBeenCalledExactlyOnceWith("2026-07-17T00:00:00.000Z");
  });
});
