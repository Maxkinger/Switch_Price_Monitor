// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProductApiClient } from "../src/app/api-client";
import { DashboardPage } from "../src/app/dashboard-page";
import { SubscriptionDetailPage } from "../src/app/subscription-detail-page";
import type { DashboardOverview, SubscriptionDetail } from "../src/app/dashboard-api-client";

/** 仪表盘删除测试使用固定概览，确保只验证管理员选择、确认和重读流程，不访问真实价格、Cookie 或 Worker 网络。 */
const overviewWithSubscription: DashboardOverview = {
  stats: {
    monitoredSubscriptionCount: 1,
    availableRegionPriceCount: 1,
    lastCapturedAt: "2026-07-18T00:00:00.000Z",
    nextDailyReportAt: "2026-07-19T01:00:00.000Z",
  },
  subscriptions: [{
    subscriptionId: "subscription-overcooked-2",
    gameId: "game-overcooked-2",
    nameZh: "胡闹厨房 2",
    nameEn: "Overcooked! 2",
    enabled: true,
    regionalProductIds: ["product-overcooked-2-us"],
    allRegionHistoricalLow: null,
    regions: [{
      regionalProductId: "product-overcooked-2-us",
      regionCode: "US",
      currency: "USD",
      current: { amountMinor: 999, cnyFen: 7200, source: "official", capturedAt: "2026-07-18T00:00:00.000Z" },
      historicalLow: null,
      isStale: false,
    }],
  }],
};

/** 删除后由 Worker 重读的空概览，页面不得在本地手工裁剪统计、地区价格或历史最低价。 */
const overviewWithoutSubscription: DashboardOverview = {
  stats: {
    monitoredSubscriptionCount: 0,
    availableRegionPriceCount: 0,
    lastCapturedAt: null,
    nextDailyReportAt: "2026-07-19T01:00:00.000Z",
  },
  subscriptions: [],
};

/** 详情删除测试只保留页面渲染所需的最小订阅模型，避免把真实网络、官方商品链接或价格采集逻辑带入 DOM 用例。 */
const subscriptionDetail: SubscriptionDetail = {
  subscriptionId: "subscription-overcooked-2",
  game: { id: "game-overcooked-2", nameZh: "胡闹厨房 2", nameEn: "Overcooked! 2", productType: "game" },
  enabled: true,
  globalTargetCnyFen: null,
  regionTargets: [],
  regions: [{
    regionalProductId: "product-overcooked-2-us",
    regionCode: "US",
    currency: "USD",
    monitored: true,
    current: { amountMinor: 999, cnyFen: 7200, source: "official", capturedAt: "2026-07-18T00:00:00.000Z" },
    historicalLow: null,
    isStale: false,
  }],
};

/** 仪表盘多选与确认删除必须把选择控件和详情导航分开，避免点击复选框意外离开当前页面。 */
describe("仪表盘订阅硬删除", () => {
  afterEach(() => {
    // DOM 测试必须显式销毁页面，防止前一用例的确认弹窗或异步读取影响下一次的安全断言。
    cleanup();
  });

  it("selects a subscription without navigating and exposes the confirmed-delete action", async () => {
    const user = userEvent.setup();
    const api = {
      getDashboard: vi.fn(async () => overviewWithSubscription),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
    };
    const onNavigate = vi.fn();

    render(<DashboardPage api={api} onNavigate={onNavigate} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "删除已选（1）" }).hasAttribute("disabled")).toBe(false);
  });

  it("sends deletion only after confirmation and then re-reads the dashboard", async () => {
    const user = userEvent.setup();
    const api = {
      getDashboard: vi.fn()
        .mockResolvedValueOnce(overviewWithSubscription)
        .mockResolvedValueOnce(overviewWithoutSubscription),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(async () => ({ deletedSubscriptionIds: ["subscription-overcooked-2"] })),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));
    await user.click(screen.getByRole("button", { name: "删除已选（1）" }));
    expect(api.deleteSubscriptions).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "永久删除订阅" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(api.deleteSubscriptions).toHaveBeenCalledWith(["subscription-overcooked-2"]));
    expect(await screen.findByRole("heading", { name: "还没有订阅" })).toBeTruthy();
    expect(api.getDashboard).toHaveBeenCalledTimes(2);
  });
});

/** 详情页删除同样必须经过共享确认框；成功后清理本地详情草稿并返回仪表盘，不能停留在已删除的价格页面。 */
describe("订阅详情硬删除", () => {
  afterEach(() => {
    // 每个 DOM 用例都销毁弹窗与异步详情读取，避免永久删除确认状态跨用例泄漏。
    cleanup();
  });

  it("returns to the dashboard only after the detail deletion is confirmed", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const api = {
      getSubscription: vi.fn(async () => subscriptionDetail),
      refreshNow: vi.fn(),
      updateSubscription: vi.fn(),
      resolveMissingRegions: vi.fn(),
      completeMissingRegions: vi.fn(),
      deleteSubscriptions: vi.fn(async () => ({ deletedSubscriptionIds: ["subscription-overcooked-2"] })),
    };

    render(<SubscriptionDetailPage api={api} productApi={{} as ReturnType<typeof createProductApiClient>} subscriptionId="subscription-overcooked-2" onBack={onBack} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "删除订阅" }));
    expect(api.deleteSubscriptions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(api.deleteSubscriptions).toHaveBeenCalledWith(["subscription-overcooked-2"]));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
