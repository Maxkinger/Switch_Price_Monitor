import { describe, expect, it, vi } from "vitest";

import { runScheduled } from "../src/worker/services/scheduler-service";
import type { DailyReportSubscription, TelegramMessage } from "../src/worker/services/report-service";

describe("scheduled daily report dispatch", () => {
  it("dispatches the Chinese daily report only at the configured local minute", async () => {
    // Cron 以 UTC 触发而管理员按本地时间设定日报；测试固定北京时间 09:00，确保时区换算而非 UTC 字符串比较决定是否发送。
    const telegram = { send: vi.fn<(messages: TelegramMessage[]) => Promise<Array<{ index: number; delivered: boolean; status: number | null }>>>().mockResolvedValue([{ index: 0, delivered: true, status: 200 }]) };
    const overview = { getOverview: vi.fn<() => Promise<{ subscriptions: DailyReportSubscription[] }>>().mockResolvedValue({ subscriptions: [subscription] }) };
    const settings = { get: vi.fn<() => Promise<{ timezone: string; dailyReportTime: string }>>().mockResolvedValue({ timezone: "Asia/Shanghai", dailyReportTime: "09:00" }) };

    const delivered = await runScheduled("2026-07-16T01:00:00.000Z", { settings, overview, telegram });
    const skipped = await runScheduled("2026-07-16T01:01:00.000Z", { settings, overview, telegram });

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

    await expect(runScheduled("2026-07-16T01:00:00.000Z", { settings, overview })).resolves.toEqual({ kind: "telegram-not-configured" });
    expect(overview.getOverview).not.toHaveBeenCalled();
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
