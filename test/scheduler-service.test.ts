import { describe, expect, it, vi } from "vitest";

import * as schedulerService from "../src/worker/services/scheduler-service";
import { runPendingNotificationDelivery, type PendingNotificationDeliveryDependencies, type PendingNotificationDeliveryResult } from "../src/worker/services/scheduler-service";
import type { PendingNotificationEvent } from "../src/worker/repositories/notification-event-repository";
import type { DailyReportSubscription, TelegramMessage } from "../src/worker/services/report-service";

/**
 * 此测试函数类型引用生产端口，确保读取 pending、调用既有 Telegram 边界和成功回写审计状态的契约不会随重构漂移。
 * TDD 的缺失实现验证已在本次改动开始时完成；此处不重复声明一份可能过期的本地依赖模型。
 */
type PendingNotificationDeliveryRunner = (
  now: string,
  dependencies: PendingNotificationDeliveryDependencies,
) => Promise<PendingNotificationDeliveryResult>;

describe("scheduled daily report dispatch", () => {
  it("dispatches the Chinese daily report only at the configured local minute", async () => {
    // Cron 以 UTC 触发而管理员按本地时间设定日报；测试固定北京时间 09:00，确保时区换算而非 UTC 字符串比较决定是否发送。
    const telegram = { send: vi.fn<(messages: TelegramMessage[]) => Promise<Array<{ index: number; delivered: boolean; status: number | null }>>>().mockResolvedValue([{ index: 0, delivered: true, status: 200 }]) };
    const overview = { getOverview: vi.fn<() => Promise<{ subscriptions: DailyReportSubscription[] }>>().mockResolvedValue({ subscriptions: [subscription] }) };
    const settings = { get: vi.fn<() => Promise<{ timezone: string; dailyReportTime: string }>>().mockResolvedValue({ timezone: "Asia/Shanghai", dailyReportTime: "09:00" }) };

    const delivered = await schedulerService.runScheduled("2026-07-16T01:00:00.000Z", { settings, overview, telegram });
    const skipped = await schedulerService.runScheduled("2026-07-16T01:01:00.000Z", { settings, overview, telegram });

    expect(delivered).toEqual({ kind: "daily-report-dispatched", deliveries: [{ index: 0, delivered: true, status: 200 }] });
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0][0][0].text).toContain("《胡闹厨房 2》");
    expect(skipped).toEqual({ kind: "not-due" });
    expect(overview.getOverview).toHaveBeenCalledTimes(1);
  });

  it("does not load price data when Telegram credentials are unavailable", async () => {
    // Secret 尚未配置时不应读取全部价格历史或尝试外部请求；部署初期可安全运行 Cron，待管理员完成秘密配置后自动生效。
    const overview = { getOverview: vi.fn<() => Promise<{ subscriptions: DailyReportSubscription[] }>>() };
    const settings = { get: vi.fn<() => Promise<{ timezone: string; dailyReportTime: string }>>().mockResolvedValue({ timezone: "Asia/Shanghai", dailyReportTime: "09:00" }) };

    await expect(schedulerService.runScheduled("2026-07-16T01:00:00.000Z", { settings, overview })).resolves.toEqual({ kind: "telegram-not-configured" });
    expect(overview.getOverview).not.toHaveBeenCalled();
  });

  it("runs retention maintenance through the dedicated six-hour scheduling boundary", async () => {
    // 数据保留是独立的存储安全任务；六小时入口避免每分钟日报检查重复扫描历史，同时为后续同频价格采集预留单一边界。
    const retention = { cleanup: vi.fn<(now: string, policy: "forever" | "one-year" | "two-years") => Promise<{ priceSnapshotsDeleted: number; fetchLogsDeleted: number }>>().mockResolvedValue({ priceSnapshotsDeleted: 2, fetchLogsDeleted: 3 }) };
    const settings = { get: vi.fn<() => Promise<{ priceHistoryRetention: "two-years" }>>().mockResolvedValue({ priceHistoryRetention: "two-years" }) };

    await expect(schedulerService.runScheduledMaintenance("2026-07-16T01:01:00.000Z", { settings, retention })).resolves.toEqual({ kind: "maintenance-completed", cleanup: { priceSnapshotsDeleted: 2, fetchLogsDeleted: 3 } });
    expect(retention.cleanup).toHaveBeenCalledExactlyOnceWith("2026-07-16T01:01:00.000Z", "two-years");
  });

  it("marks an immediate notification as delivered only after Telegram accepts it", async () => {
    // 同一事件会在 Cron 重试时再次被读取；只有 Telegram 明确成功才允许更新审计状态，避免网络失败造成消息永久丢失。
    const runner: PendingNotificationDeliveryRunner = runPendingNotificationDelivery;
    const event: PendingNotificationEvent = { regionalProductId: "product-us", eventType: "collection-failure", dedupeKey: "product-us:collection-failure:1", createdAt: "2026-07-16T01:00:00.000Z", gameNameZh: "胡闹厨房 2", regionCode: "US" };
    const events = { pending: vi.fn<() => Promise<PendingNotificationEvent[]>>().mockResolvedValue([event]) };
    const telegram = { send: vi.fn<(messages: TelegramMessage[]) => Promise<Array<{ index: number; delivered: boolean; status: number | null }>>>().mockResolvedValue([{ index: 0, delivered: true, status: 200 }]) };
    const marker = { markDelivered: vi.fn<(dedupeKey: string, sentAt: string) => Promise<boolean>>().mockResolvedValue(true) };

    await expect(runner("2026-07-16T01:01:00.000Z", { events, telegram, marker })).resolves.toEqual({ kind: "pending-notifications-dispatched", attempted: 1, delivered: 1 });
    expect(telegram.send).toHaveBeenCalledWith([expect.objectContaining({ text: expect.stringContaining("《胡闹厨房 2》美区") })]);
    expect(marker.markDelivered).toHaveBeenCalledExactlyOnceWith(event.dedupeKey, "2026-07-16T01:01:00.000Z");
  });

  it("keeps a failed immediate notification pending for a later retry", async () => {
    // Telegram 网络或服务端错误不能被误记为送达；不调用标记仓储可保留 pending 事件，下一分钟 Cron 才能安全重试。
    const runner: PendingNotificationDeliveryRunner = runPendingNotificationDelivery;
    const event: PendingNotificationEvent = { regionalProductId: "product-jp", eventType: "collection-recovered", dedupeKey: "product-jp:collection-recovered:1", createdAt: "2026-07-16T01:00:00.000Z", gameNameZh: "胡闹厨房 2", regionCode: "JP" };
    const events = { pending: vi.fn<() => Promise<PendingNotificationEvent[]>>().mockResolvedValue([event]) };
    const telegram = { send: vi.fn<(messages: TelegramMessage[]) => Promise<Array<{ index: number; delivered: boolean; status: number | null }>>>().mockResolvedValue([{ index: 0, delivered: false, status: 502 }]) };
    const marker = { markDelivered: vi.fn<(dedupeKey: string, sentAt: string) => Promise<boolean>>() };

    await expect(runner("2026-07-16T01:01:00.000Z", { events, telegram, marker })).resolves.toEqual({ kind: "pending-notifications-dispatched", attempted: 1, delivered: 0 });
    expect(marker.markDelivered).not.toHaveBeenCalled();
  });
});

const subscription: DailyReportSubscription = {
  // 最小日报夹具只保留一款官方价格商品，验证调度器把数据交给已验证的格式化与发送边界。
  subscriptionId: "subscription-overcooked-2",
  nameZh: "胡闹厨房 2",
  enabled: true,
  allRegionHistoricalLow: null,
  regions: [{ regionalProductId: "product-us", regionCode: "US", currency: "USD", current: { amountMinor: 999, cnyFen: 6800, source: "official", capturedAt: "2026-07-16T01:00:00.000Z" }, historicalLow: null }],
};
