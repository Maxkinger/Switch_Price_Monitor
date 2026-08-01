import { describe, expect, it, vi } from "vitest";

import { runSixHourCollection } from "../src/services/scheduler-service";

describe("runSixHourCollection", () => {
  it("runs maintenance and one collection without reading manual refresh state", async () => {
    // 手动刷新已在 HTTP 请求内完成；六小时 Node 调度只负责固定自动采集，不能再读取或认领任何旧队列状态。
    const order: string[] = [];
    const retention = {
      cleanup: vi.fn().mockImplementation(async () => {
        order.push("retention");
        return { priceSnapshotsDeleted: 0, fetchLogsDeleted: 0 };
      }),
    };
    const collection = {
      run: vi.fn().mockImplementation(async () => {
        order.push("collection");
        return { attempted: 2, collected: 2, stale: 0 };
      }),
    };

    await expect(runSixHourCollection("2026-07-17T00:00:00.000Z", {
      settings: { get: async () => ({ priceHistoryRetention: "forever" as const }) },
      retention,
      collection,
    })).resolves.toEqual({ kind: "collection-completed" });
    expect(retention.cleanup).toHaveBeenCalledExactlyOnceWith(
      "2026-07-17T00:00:00.000Z",
      "forever",
    );
    expect(collection.run).toHaveBeenCalledExactlyOnceWith("2026-07-17T00:00:00.000Z");
    expect(order).toEqual(["retention", "collection"]);
  });
});
