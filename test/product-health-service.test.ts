import { describe, expect, it } from "vitest";

import { ProductHealthService } from "../src/services/product-health-service";
import {
  InMemoryNotificationEventStore,
  InMemoryProductHealthStore,
} from "./support/in-memory-business-stores";

describe("ProductHealthService", () => {
  it("persists the third-failure alert state and emits one recovery after a later success", async () => {
    // 三次失败跨独立服务调用模拟三个 Cron 周期；平台中立端口保存跨轮状态，数据库唯一约束与并发争用另由 PostgreSQL 集成测试覆盖。
    const state = new InMemoryProductHealthStore();
    const notifications = new InMemoryNotificationEventStore();
    const health = new ProductHealthService(state, notifications);

    await expect(health.record("product-health", false, "2026-07-16T00:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 1 });
    await expect(health.record("product-health", false, "2026-07-16T06:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 2 });
    await expect(health.record("product-health", false, "2026-07-16T12:00:00.000Z")).resolves.toMatchObject({ notification: "failure", consecutiveFailures: 3 });
    // 第四次失败必须由服务状态机返回 none，且仍只有第三次失败的一份通知；这验证业务去重，而不是直接调用 fake 自证唯一键。
    await expect(health.record("product-health", false, "2026-07-16T18:00:00.000Z")).resolves.toMatchObject({ notification: "none", consecutiveFailures: 4, failureNotified: true });
    expect(notifications.inspectAll()).toMatchObject([
      { eventType: "collection-failure", status: "pending" },
    ]);

    await expect(health.record("product-health", true, "2026-07-17T00:00:00.000Z")).resolves.toMatchObject({ notification: "recovered", consecutiveFailures: 0, failureNotified: false });
    expect(state.inspect("product-health")).toMatchObject({ consecutiveFailures: 0, failureNotified: false, lastSuccessAt: "2026-07-17T00:00:00.000Z" });
    expect(notifications.inspectAll()).toMatchObject([
      { eventType: "collection-failure", status: "pending" },
      { eventType: "collection-recovered", status: "pending" },
    ]);
    expect(notifications.inspectAll()).toHaveLength(2);
  });
});
