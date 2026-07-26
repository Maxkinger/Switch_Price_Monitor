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
    timezone: "Asia/Shanghai",
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
    timezone: "Asia/Shanghai",
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

/**
 * 五区展示夹具严格复刻管理员确认的官网价格文字所需的最小货币单位。
 * 它只用于前端 DOM 断言，不会写入订阅、价格快照或调用任天堂官方接口，避免把草图数据误当真实采集结果。
 */
const localizedOverview: DashboardOverview = {
  stats: {
    monitoredSubscriptionCount: 1,
    availableRegionPriceCount: 5,
    lastCapturedAt: "2026-07-19T01:00:00.000Z",
    timezone: "Asia/Shanghai",
    nextDailyReportAt: "2026-07-20T01:00:00.000Z",
  },
  subscriptions: [{
    subscriptionId: "subscription-overcooked-2-switch-2-edition",
    gameId: "game-overcooked-2-switch-2-edition",
    nameZh: "胡闹厨房 2 Nintendo Switch 2 Edition",
    nameEn: "Overcooked! 2 – Nintendo Switch 2 Edition",
    enabled: true,
    regionalProductIds: ["overcooked-us", "overcooked-mx", "overcooked-jp", "overcooked-br", "overcooked-hk"],
    // 跨区最低价复用 Worker 的完整价格模型，来源和采集时刻不可省略，避免测试夹具绕过真实 API 数据约束。
    allRegionHistoricalLow: { regionalProductId: "overcooked-jp", regionCode: "JP", amountMinor: 1999, currency: "JPY", cnyFen: 9300, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" },
    regions: [
      { regionalProductId: "overcooked-us", regionCode: "US", currency: "USD", current: { amountMinor: 3999, cnyFen: 28800, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, historicalLow: { amountMinor: 2999, cnyFen: 21600, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, isStale: false },
      { regionalProductId: "overcooked-mx", regionCode: "MX", currency: "MXN", current: { amountMinor: 3999, cnyFen: 16700, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, historicalLow: { amountMinor: 3499, cnyFen: 14600, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, isStale: false },
      { regionalProductId: "overcooked-jp", regionCode: "JP", currency: "JPY", current: { amountMinor: 1999, cnyFen: 9300, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, historicalLow: { amountMinor: 1999, cnyFen: 9300, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, isStale: false },
      { regionalProductId: "overcooked-br", regionCode: "BR", currency: "BRL", current: { amountMinor: 9900, cnyFen: 12800, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, historicalLow: { amountMinor: 7900, cnyFen: 10200, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, isStale: false },
      { regionalProductId: "overcooked-hk", regionCode: "HK", currency: "HKD", current: { amountMinor: 19800, cnyFen: 18300, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, historicalLow: { amountMinor: 16800, cnyFen: 15600, source: "official", capturedAt: "2026-07-19T01:00:00.000Z" }, isStale: false },
    ],
  }],
};

/**
 * 详情夹具与概览使用相同的五区金额，确保两页不会因各自格式化逻辑分叉而给同一商品显示不同价格。
 * monitored 固定为 true，只验证价格阅读口径，不把地区勾选保存这一独立业务流程混入展示用例。
 */
const localizedSubscriptionDetail: SubscriptionDetail = {
  subscriptionId: "subscription-overcooked-2-switch-2-edition",
  game: { id: "game-overcooked-2-switch-2-edition", nameZh: "胡闹厨房 2 Nintendo Switch 2 Edition", nameEn: "Overcooked! 2 – Nintendo Switch 2 Edition", productType: "upgrade_pack" },
  enabled: true,
  globalTargetCnyFen: null,
  regionTargets: [],
  regions: localizedOverview.subscriptions[0].regions.map((region) => ({
    ...region,
    monitored: true,
  })),
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
      syncGameNames: vi.fn(async () => []),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: [] })),
    };
    const onNavigate = vi.fn();

    render(<DashboardPage api={api} onNavigate={onNavigate} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "删除已选（1）" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not request game-name sync while the dashboard is loading", async () => {
    // 若把同步放进加载副作用，此用例会失败：外部名称解析只能由管理员明确点击触发，页面初始读取不得放大任天堂请求或覆盖人工名称。
    const api = {
      getDashboard: vi.fn(async () => overviewWithSubscription),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(),
      confirmGameNameSync: vi.fn(),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);

    expect(api.syncGameNames).not.toHaveBeenCalled();
    await screen.findByRole("heading", { name: "胡闹厨房 2" });
    expect(api.syncGameNames).not.toHaveBeenCalled();
  });

  it("syncs an explicitly selected subscription, refreshes official results, and never opens an unnecessary decision dialog", async () => {
    // 官方成功项已由 Worker 立即保存；页面只能在管理员点击后发送选中 ID，并通过第二次概览读取显示结果，不能本地伪造名称或自动弹出人工决定。
    const user = userEvent.setup();
    const refreshed = { ...overviewWithSubscription, subscriptions: [{ ...overviewWithSubscription.subscriptions[0], nameZh: "煮过头 2" }] };
    const api = {
      getDashboard: vi.fn().mockResolvedValueOnce(overviewWithSubscription).mockResolvedValueOnce(refreshed),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => [{ subscriptionId: "subscription-overcooked-2", status: "updated_official" as const, nameEn: "Overcooked! 2" }]),
      confirmGameNameSync: vi.fn(),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));
    await user.click(screen.getByRole("button", { name: "同步游戏名称" }));

    await waitFor(() => expect(api.syncGameNames).toHaveBeenCalledWith(["subscription-overcooked-2"]));
    expect(await screen.findByRole("heading", { name: "煮过头 2" })).toBeTruthy();
    expect(api.getDashboard).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: "确认游戏名称" })).toBeNull();
  });

  it("submits an explicit manual Chinese decision after a needs-decision sync and refreshes the dashboard", async () => {
    // 需要人工项不能由浏览器猜测来源；管理员填写中文后只提交 subscriptionId 与文本，保存完成仍须重新读取 Worker 概览。
    const user = userEvent.setup();
    const refreshed = { ...overviewWithSubscription, subscriptions: [{ ...overviewWithSubscription.subscriptions[0], nameZh: "胡闹厨房 2：官方中文" }] };
    const api = {
      getDashboard: vi.fn().mockResolvedValueOnce(overviewWithSubscription).mockResolvedValueOnce(refreshed).mockResolvedValueOnce(refreshed),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => [{ subscriptionId: "subscription-overcooked-2", status: "needs-decision" as const, nameEn: "Overcooked! 2" }]),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: ["subscription-overcooked-2"] })),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));
    await user.click(screen.getByRole("button", { name: "同步游戏名称" }));
    await user.type(await screen.findByRole("textbox", { name: "中文展示名称 Overcooked! 2" }), "胡闹厨房 2：官方中文");
    await user.click(screen.getByRole("button", { name: "确认名称决定" }));

    await waitFor(() => expect(api.confirmGameNameSync).toHaveBeenCalledWith([{ subscriptionId: "subscription-overcooked-2", nameZh: "胡闹厨房 2：官方中文" }]));
    expect(await screen.findByRole("heading", { name: "胡闹厨房 2：官方中文" })).toBeTruthy();
    expect(api.getDashboard).toHaveBeenCalledTimes(3);
  });

  it("submits an empty decision when the administrator keeps the official English fallback", async () => {
    // “保留官方英文”只清空人工值；提交载荷必须省略 nameZh，让 Worker 记录可审计的英文回退而不是让页面自写名称来源。
    const user = userEvent.setup();
    const api = {
      getDashboard: vi.fn().mockResolvedValueOnce(overviewWithSubscription).mockResolvedValueOnce(overviewWithSubscription).mockResolvedValueOnce(overviewWithSubscription),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => [{ subscriptionId: "subscription-overcooked-2", status: "needs-decision" as const, nameEn: "Overcooked! 2" }]),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: ["subscription-overcooked-2"] })),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "选择 胡闹厨房 2" }));
    await user.click(screen.getByRole("button", { name: "同步游戏名称" }));
    await user.click(await screen.findByRole("button", { name: "保留官方英文" }));
    await user.click(screen.getByRole("button", { name: "确认名称决定" }));

    await waitFor(() => expect(api.confirmGameNameSync).toHaveBeenCalledWith([{ subscriptionId: "subscription-overcooked-2" }]));
    expect(api.getDashboard).toHaveBeenCalledTimes(3);
  });

  it("renders collection and report times in the saved administrator timezone", async () => {
    // 浏览器时区可能与日报时区不同；页面必须使用 Worker 明确返回的 IANA 时区，让两个时间的阅读口径保持一致。
    const api = {
      getDashboard: vi.fn(async () => overviewWithSubscription),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => []),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: [] })),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("最近采集：2026-07-18 08:00:00（Asia/Shanghai）")).toBeTruthy();
    expect(screen.getByText("下次日报：2026-07-19 09:00:00（Asia/Shanghai）")).toBeTruthy();
  });

  it("sends deletion only after confirmation and then re-reads the dashboard", async () => {
    const user = userEvent.setup();
    const api = {
      getDashboard: vi.fn()
        .mockResolvedValueOnce(overviewWithSubscription)
        .mockResolvedValueOnce(overviewWithoutSubscription),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(async () => ({ deletedSubscriptionIds: ["subscription-overcooked-2"] })),
      syncGameNames: vi.fn(async () => []),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: [] })),
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

/** 仪表盘与详情必须消费同一地区格式化逻辑，防止任一页面退回内部代码、重复币种或过期的旧货币前缀。 */
describe("地区中文名与官网价格文字", () => {
  afterEach(() => {
    // 五区夹具包含多个相同 "$" 文本；每例销毁 DOM 后再断言，避免前一页面的节点造成误匹配。
    cleanup();
  });

  it("shows Chinese region names and confirmed official prices on the dashboard", async () => {
    const api = {
      getDashboard: vi.fn(async () => localizedOverview),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => []),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: [] })),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("美国区")).toBeTruthy();
    expect(screen.getAllByText("$ 39.99")).toHaveLength(2);
    expect(screen.getByText("墨西哥区")).toBeTruthy();
    expect(screen.getByText("日本区")).toBeTruthy();
    expect(screen.getByText("1,999 円（税込）")).toBeTruthy();
    expect(screen.getByText("巴西区")).toBeTruthy();
    expect(screen.getByText("R$ 99.00")).toBeTruthy();
    expect(screen.getByText("香港区")).toBeTruthy();
    expect(screen.getByText("HKD 198")).toBeTruthy();
    expect(screen.queryByText("US")).toBeNull();
  });

  it("always renders dashboard region prices in the product owner's fixed five-region order", async () => {
    // Worker 返回顺序可能来自数据库插入、补全或未来 API 排序；仪表盘必须在展示层固定为美/墨/巴/港/日，
    // 这样管理员每次横向比较价格时不用重新寻找同一区域，且缺失地区不会改变已显示地区的相对顺序。
    const api = {
      getDashboard: vi.fn(async () => localizedOverview),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => []),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: [] })),
    };

    const { container } = render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByText("胡闹厨房 2 Nintendo Switch 2 Edition");

    const regionNames = [...container.querySelectorAll(".summary-regions b")].map((node) => node.textContent);
    expect(regionNames).toEqual(["美国区", "墨西哥区", "巴西区", "香港区", "日本区"]);
  });

  it("uses the same Chinese region names and price copy on the subscription detail", async () => {
    const api = {
      getSubscription: vi.fn(async () => localizedSubscriptionDetail),
      refreshNow: vi.fn(),
      updateSubscription: vi.fn(),
      resolveMissingRegions: vi.fn(),
      completeMissingRegions: vi.fn(),
      deleteSubscriptions: vi.fn(),
    };

    render(<SubscriptionDetailPage api={api} productApi={{} as ReturnType<typeof createProductApiClient>} subscriptionId="subscription-overcooked-2-switch-2-edition" onBack={vi.fn()} onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("美国区")).toBeTruthy();
    expect(screen.getAllByText("$ 39.99")).toHaveLength(2);
    expect(screen.getByText("日本区")).toBeTruthy();
    expect(screen.getByText("1,999 円（税込）")).toBeTruthy();
    expect(screen.getByText("香港区")).toBeTruthy();
    expect(screen.getByText("HKD 198")).toBeTruthy();
    expect(screen.queryByText("US · USD")).toBeNull();
  });
});

/** 已保存的官方英文回退同样是可审计的最终名称；展示层不得重新套用已移除的词表把它伪装成中文。 */
describe("中文游戏名展示", () => {
  afterEach(() => {
    // 每个页面用例都清理异步读取后的 DOM，避免相同英文标题在不同页面之间互相污染断言。
    cleanup();
  });

  it("preserves an explicit official English fallback on dashboard cards", async () => {
    const englishOverview: DashboardOverview = {
      ...localizedOverview,
      subscriptions: [{
        ...localizedOverview.subscriptions[0],
        nameZh: "Overcooked! 2 – Nintendo Switch 2 Edition",
        nameEn: "Overcooked! 2 – Nintendo Switch 2 Edition",
      }],
    };
    const api = {
      getDashboard: vi.fn(async () => englishOverview),
      refreshNow: vi.fn(),
      deleteSubscriptions: vi.fn(),
      syncGameNames: vi.fn(async () => []),
      confirmGameNameSync: vi.fn(async () => ({ updatedSubscriptionIds: [] })),
    };

    render(<DashboardPage api={api} onNavigate={vi.fn()} onUnauthorized={vi.fn()} />);

    // 名称已由服务端明确保存为英文回退；若展示层重新引入词表，本断言会失败并暴露页面改写已审计名称的回归。
    expect(await screen.findByRole("heading", { name: "Overcooked! 2 – Nintendo Switch 2 Edition" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "选择 Overcooked! 2 – Nintendo Switch 2 Edition" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "胡闹厨房 2 Nintendo Switch 2 Edition" })).toBeNull();
  });

  it("preserves an explicit official English fallback on the subscription detail page", async () => {
    const englishDetail: SubscriptionDetail = {
      ...localizedSubscriptionDetail,
      game: {
        ...localizedSubscriptionDetail.game,
        nameZh: "Overcooked! 2 – Nintendo Switch 2 Edition",
        nameEn: "Overcooked! 2 – Nintendo Switch 2 Edition",
      },
    };
    const api = {
      getSubscription: vi.fn(async () => englishDetail),
      refreshNow: vi.fn(),
      updateSubscription: vi.fn(),
      resolveMissingRegions: vi.fn(),
      completeMissingRegions: vi.fn(),
      deleteSubscriptions: vi.fn(),
    };

    render(<SubscriptionDetailPage api={api} productApi={{} as ReturnType<typeof createProductApiClient>} subscriptionId="subscription-overcooked-2-switch-2-edition" onBack={vi.fn()} onUnauthorized={vi.fn()} />);

    // 详情页与仪表盘必须读取同一保存值；人工中文或官方中文由同步服务写入后才会显示中文，不能由页面自行翻译。
    expect(await screen.findByRole("heading", { name: "Overcooked! 2 – Nintendo Switch 2 Edition" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "胡闹厨房 2 Nintendo Switch 2 Edition" })).toBeNull();
  });
});
