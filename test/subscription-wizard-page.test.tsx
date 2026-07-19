// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type RegionResolutionResponse, createProductApiClient } from "../src/app/api-client";
import { SubscriptionWizardPage } from "../src/app/subscription-wizard-page";
import type { OfficialProductCandidate } from "../src/shared/domain";

/** 默认区候选是跨区解析锚点；测试固定公开字段，确保折叠交互不依赖任天堂网络、Cookie 或真实订阅写入。 */
const usCandidate: OfficialProductCandidate = {
  regionCode: "US",
  productUrl: "https://www.nintendo.com/us/store/products/overcooked-2-nintendo-switch-2-edition-switch/",
  canonicalTitle: "Overcooked! 2 – Nintendo Switch 2 Edition",
  publisher: "Team17",
  productType: "game",
  currency: "USD",
  coverUrl: null,
  currentPriceMinor: 2999,
  regularPriceMinor: null,
};

/** 日区第一项代表 Worker 已排序的高相关候选，第二项则代表仍可审计但默认折叠的同类型官方候选。 */
const featuredJapaneseCandidate: OfficialProductCandidate = {
  ...usCandidate,
  regionCode: "JP",
  productUrl: "https://store-jp.nintendo.com/item/software/D70010000106252/",
  canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
  currency: "JPY",
  currentPriceMinor: 3740,
};

const remainingJapaneseCandidate: OfficialProductCandidate = {
  ...featuredJapaneseCandidate,
  productUrl: "https://store-jp.nintendo.com/item/software/D70010000999999/",
  canonicalTitle: "Unrelated Nintendo Switch 2 Edition",
  publisher: "Another Publisher",
};

/** 每个 DOM 用例都提供完整的同源客户端表面，未调用的方法显式桩化以防测试偶然触发真实请求。 */
function wizardApi(resolutions: RegionResolutionResponse[]): ReturnType<typeof createProductApiClient> {
  return {
    searchProducts: vi.fn(async () => ({ status: "available" as const, candidates: [usCandidate] })),
    resolveOfficialLink: vi.fn(),
    resolveRegions: vi.fn(async () => resolutions),
    previewSources: vi.fn(async () => []),
    confirmSubscriptions: vi.fn(async () => []),
  };
}

describe("添加订阅向导的跨区候选折叠", () => {
  afterEach(() => {
    // 清理会移除上一用例的异步 React 树，避免折叠状态或候选卡影响下一次可访问性断言。
    cleanup();
  });

  it("shows featured Japanese candidates before expanding the remaining official candidates", async () => {
    const user = userEvent.setup();
    const candidateKey = `${usCandidate.regionCode}:${usCandidate.productUrl}`;
    const api = wizardApi([{
      candidateKey,
      regionCode: "JP",
      status: "needs-manual-selection",
      message: "请选择该区官方候选商品",
      candidates: [featuredJapaneseCandidate, remainingJapaneseCandidate],
      featuredCandidateCount: 1,
    }]);

    render(<SubscriptionWizardPage api={api} onUnauthorized={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    expect(await screen.findByRole("button", { name: /Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unrelated Nintendo Switch 2 Edition/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "显示更多官方候选（1）" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Unrelated Nintendo Switch 2 Edition/ })).toBeTruthy());
  });

  it("retries Japanese regional discovery after a safe manual-link message and renders the automatic candidate", async () => {
    // Browser Run 暂不可用时必须保留人工链接输入，同时管理员可重新发起同一批安全地区解析；第二次响应只能由 Worker 的自动候选更新页面。
    const user = userEvent.setup();
    const candidateKey = `${usCandidate.regionCode}:${usCandidate.productUrl}`;
    const japaneseUpgrade: OfficialProductCandidate = {
      ...featuredJapaneseCandidate,
      productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
      canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition アップグレードパス",
      productType: "upgrade-pack",
    };
    let resolveRetry: (value: RegionResolutionResponse[]) => void = () => undefined;
    const retryPending = new Promise<RegionResolutionResponse[]>((resolve) => { resolveRetry = resolve; });
    const api = wizardApi([]);
    vi.mocked(api.resolveRegions)
      .mockResolvedValueOnce([{ candidateKey, regionCode: "JP", status: "needs-manual-link", message: "日区自动核验暂不可用，请重新核验或粘贴官方链接。" }])
      // 第二次请求保持 pending，证明按钮会在 Browser Run 重试尚未结算时禁用，不能被连续点击并发消耗浏览器配额。
      .mockReturnValueOnce(retryPending);

    render(<SubscriptionWizardPage api={api} onUnauthorized={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    expect(await screen.findByText("日区自动核验暂不可用，请重新核验或粘贴官方链接。")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "JP 任天堂官方商品链接" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新核验" }));

    await waitFor(() => expect(api.resolveRegions).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("button", { name: "重新核验" }) as HTMLButtonElement).disabled).toBe(true);
    resolveRetry([{ candidateKey, regionCode: "JP", status: "automatic", candidate: japaneseUpgrade }]);
    expect(await screen.findByText(`已自动加入监控：${japaneseUpgrade.canonicalTitle}`)).toBeTruthy();
  });

  it("ignores a stale Japanese retry after a new search starts a newer regional resolution", async () => {
    // 搜索会重置地区确认上下文：旧 Browser Run 即使稍后成功，也不能把自动候选或安全提示写回新搜索；更不能在新一代仍 pending 时错误关闭加载状态。
    const user = userEvent.setup();
    const candidateKey = `${usCandidate.regionCode}:${usCandidate.productUrl}`;
    const staleJapaneseUpgrade: OfficialProductCandidate = {
      ...featuredJapaneseCandidate,
      productUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
      canonicalTitle: "过期日区升级包",
      productType: "upgrade-pack",
    };
    let resolveStaleRetry: (value: RegionResolutionResponse[]) => void = () => undefined;
    let resolveFreshResolution: (value: RegionResolutionResponse[]) => void = () => undefined;
    let resolveRefreshedSearch: (value: { status: "available"; candidates: OfficialProductCandidate[] }) => void = () => undefined;
    const staleRetry = new Promise<RegionResolutionResponse[]>((resolve) => { resolveStaleRetry = resolve; });
    const freshResolution = new Promise<RegionResolutionResponse[]>((resolve) => { resolveFreshResolution = resolve; });
    const refreshedSearch = new Promise<{ status: "available"; candidates: OfficialProductCandidate[] }>((resolve) => { resolveRefreshedSearch = resolve; });
    const api = wizardApi([]);
    vi.mocked(api.searchProducts)
      .mockResolvedValueOnce({ status: "available", candidates: [usCandidate] })
      // 第二次搜索保持 pending，专门暴露旧地区面板在新搜索尚未结算时可能被再次点击的并发窗口。
      .mockReturnValueOnce(refreshedSearch);
    vi.mocked(api.resolveRegions)
      .mockResolvedValueOnce([{ candidateKey, regionCode: "JP", status: "needs-manual-link", message: "日区自动核验暂不可用，请重新核验或粘贴官方链接。" }])
      .mockReturnValueOnce(staleRetry)
      .mockReturnValueOnce(freshResolution);

    render(<SubscriptionWizardPage api={api} onUnauthorized={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));
    await user.click(await screen.findByRole("button", { name: "重新核验" }));
    await waitFor(() => expect(api.resolveRegions).toHaveBeenCalledTimes(2));

    await user.clear(screen.getByRole("textbox", { name: "游戏名称" }));
    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2 refreshed");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    const oldRetry = screen.getByRole("button", { name: "重新核验" }) as HTMLButtonElement;
    const oldResolveRegions = screen.getByRole("button", { name: "核验其他地区" }) as HTMLButtonElement;
    expect(oldRetry.disabled).toBe(true);
    expect(oldResolveRegions.disabled).toBe(true);
    await user.click(oldRetry);
    await user.click(oldResolveRegions);
    expect(api.resolveRegions).toHaveBeenCalledTimes(2);

    resolveRefreshedSearch({ status: "available", candidates: [usCandidate] });
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));
    await waitFor(() => expect(api.resolveRegions).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "匹配中…" })).toBeTruthy();

    resolveStaleRetry([{ candidateKey, regionCode: "JP", status: "automatic", candidate: staleJapaneseUpgrade }]);
    await waitFor(() => expect(screen.queryByText(`已自动加入监控：${staleJapaneseUpgrade.canonicalTitle}`)).toBeNull());
    expect(screen.queryByText("日区自动核验暂不可用，请重新核验或粘贴官方链接。")).toBeNull();
    expect(screen.getByRole("button", { name: "匹配中…" })).toBeTruthy();

    resolveFreshResolution([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "核验其他地区" })).toBeTruthy());
  });
});
