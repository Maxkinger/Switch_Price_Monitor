// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type RegionResolutionResponse, createProductApiClient } from "../src/app/api-client";
import { GameNameApiError, type AiGameNameSuggestion, type GameNameSuggestionCandidate, createGameNameApiClient } from "../src/app/game-name-api-client";
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

/** 日区第一项代表服务端已排序的高相关候选，第二项则代表仍可审计但默认折叠的同类型官方候选。 */
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

/** 第二个默认区候选模拟目录未命中，专门验证批量选择时两个中文草稿不会互相覆盖。 */
const kirbyCandidate: OfficialProductCandidate = {
  ...usCandidate,
  productUrl: "https://www.nintendo.com/us/store/products/kirby-and-the-forgotten-land-switch/",
  canonicalTitle: "Kirby and the Forgotten Land",
  publisher: "Nintendo",
  currentPriceMinor: 5999,
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

/** 名称建议客户端只暴露向导所需的两类只读建议；空值必须保留为必填输入，不能由浏览器自行翻译或猜测。 */
function nameSuggestionApi(
  suggestions: Array<{ candidateKey: string; displayNameZhCn: string | null }>,
  aiSuggestions: AiGameNameSuggestion[] = [],
): Pick<ReturnType<typeof createGameNameApiClient>, "suggestNames" | "suggestAiNames"> {
  return {
    suggestNames: vi.fn(async (_candidates: GameNameSuggestionCandidate[]) => ({ suggestions })),
    suggestAiNames: vi.fn(async (_candidates: GameNameSuggestionCandidate[]) => ({ suggestions: aiSuggestions })),
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

    render(<SubscriptionWizardPage api={api} gameNameApi={nameSuggestionApi([])} onUnauthorized={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    expect(await screen.findByRole("button", { name: /Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unrelated Nintendo Switch 2 Edition/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "显示更多官方候选（1）" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Unrelated Nintendo Switch 2 Edition/ })).toBeTruthy());
  });

  it("prefills a catalog Chinese name, keeps a second draft required, and submits both independent drafts", async () => {
    // 一项建议命中、一项未命中覆盖“体验预填但不可绕过确认”的边界；最终只断言同源产品客户端收到的载荷，不模拟服务端把浏览器标题当作身份事实。
    const user = userEvent.setup();
    const api = wizardApi([]);
    vi.mocked(api.searchProducts).mockResolvedValue({ status: "available", candidates: [usCandidate, kirbyCandidate] });
    const names = nameSuggestionApi([
      { candidateKey: `US:${usCandidate.productUrl}`, displayNameZhCn: "胡闹厨房 2" },
      { candidateKey: `US:${kirbyCandidate.productUrl}`, displayNameZhCn: null },
    ]);

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "two games");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: /Kirby and the Forgotten Land/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    const overcookedName = await screen.findByRole("textbox", { name: "Overcooked! 2 – Nintendo Switch 2 Edition 的简体中文显示名称" });
    const kirbyName = screen.getByRole("textbox", { name: "Kirby and the Forgotten Land 的简体中文显示名称" });
    expect((overcookedName as HTMLInputElement).value).toBe("胡闹厨房 2");
    expect((kirbyName as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "确认订阅" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(kirbyName, "星之卡比 探索发现");
    expect((screen.getByRole("button", { name: "确认订阅" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "确认订阅" }));

    expect(api.confirmSubscriptions).toHaveBeenCalledWith([
      expect.objectContaining({ selected: usCandidate, displayNameZhCn: "胡闹厨房 2" }),
      expect.objectContaining({ selected: kirbyCandidate, displayNameZhCn: "星之卡比 探索发现" }),
    ]);
  });

  it("prefills AI suggestions only after regional verification and never replaces a later administrator draft", async () => {
    // 这条回归会在 AI 请求错误地发生在候选点击时、覆盖非空人工草稿或把 AI 文本当作已确认名称时失败。
    const user = userEvent.setup();
    let resolveLateAiResponse: (value: { suggestions: AiGameNameSuggestion[] }) => void = () => undefined;
    let aiResponseConsumed = false;
    const lateAiResponse = new Promise<{ suggestions: AiGameNameSuggestion[] }>((resolve) => { resolveLateAiResponse = resolve; });
    const api = wizardApi([]);
    const names = nameSuggestionApi([]);
    let temporaryCandidateKey = "";
    vi.mocked(names.suggestAiNames).mockImplementation(async (candidates) => {
      temporaryCandidateKey = candidates[0]?.candidateKey ?? "";
      const response = await lateAiResponse;
      // 只有 mock 已继续执行到返回点，后续断言才会覆盖 React 消费迟到响应后的真实回写分支。
      aiResponseConsumed = true;
      return response;
    });

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    expect(names.suggestAiNames).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));
    await waitFor(() => expect(names.suggestAiNames).toHaveBeenCalledTimes(1));
    const aiRequestBody = JSON.stringify(vi.mocked(names.suggestAiNames).mock.calls[0]?.[0]);
    // AI 批次键必须由浏览器本地生成且不含官方 URL；否则服务端即使丢弃额外字段，也会把真实商品地址作为合法 candidateKey 发给供应商。
    expect(temporaryCandidateKey).not.toBe("");
    expect(temporaryCandidateKey).not.toContain(usCandidate.productUrl);
    expect(aiRequestBody).not.toContain(usCandidate.productUrl);

    const input = screen.getByRole("textbox", { name: `${usCandidate.canonicalTitle} 的简体中文显示名称` });
    await user.type(input, "管理员名称");
    resolveLateAiResponse({ suggestions: [{ candidateKey: temporaryCandidateKey, displayNameZhCn: "AI 建议名", confidence: "high" }] });

    await waitFor(() => expect(aiResponseConsumed).toBe(true));
    await waitFor(() => expect((screen.getByRole("textbox", { name: `${usCandidate.canonicalTitle} 的简体中文显示名称` }) as HTMLInputElement).value).toBe("管理员名称"));
    expect(screen.queryByText("AI 建议，待确认")).toBeNull();
  });

  it("does not replace an administrator-edited whitespace draft when a late AI response settles", async () => {
    // 最终确认会单独修剪并校验空白，但编辑意图不能被体验性 AI 请求吞掉；移除“草稿存在”保护会让该用例把空白改成 AI 名称。
    const user = userEvent.setup();
    let resolveLateAiResponse: (value: { suggestions: AiGameNameSuggestion[] }) => void = () => undefined;
    let aiResponseConsumed = false;
    const lateAiResponse = new Promise<{ suggestions: AiGameNameSuggestion[] }>((resolve) => { resolveLateAiResponse = resolve; });
    const api = wizardApi([]);
    const names = nameSuggestionApi([]);
    let temporaryCandidateKey = "";
    vi.mocked(names.suggestAiNames).mockImplementation(async (candidates) => {
      temporaryCandidateKey = candidates[0]?.candidateKey ?? "";
      const response = await lateAiResponse;
      aiResponseConsumed = true;
      return response;
    });

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    const input = screen.getByRole("textbox", { name: `${usCandidate.canonicalTitle} 的简体中文显示名称` });
    await user.type(input, "   ");
    resolveLateAiResponse({ suggestions: [{ candidateKey: temporaryCandidateKey, displayNameZhCn: "AI 建议名", confidence: "high" }] });

    await waitFor(() => expect(aiResponseConsumed).toBe(true));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("   "));
    expect(screen.queryByText("AI 建议，待确认")).toBeNull();
  });

  it("marks an AI-filled empty draft as pending confirmation", async () => {
    // 标识必须源自实际 AI 写入，而不是接口成功、目录建议或名称非空本身，防止管理员误把其他来源当作模型文本。
    const user = userEvent.setup();
    const api = wizardApi([]);
    const names = nameSuggestionApi([]);
    vi.mocked(names.suggestAiNames).mockImplementation(async (candidates) => ({
      suggestions: [{ candidateKey: candidates[0]?.candidateKey ?? "missing", displayNameZhCn: "AI 建议名", confidence: "high" }],
    }));

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    expect(await screen.findByDisplayValue("AI 建议名")).toBeTruthy();
    expect(screen.getByText("AI 建议，待确认")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认订阅" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("maps multiple URL-free AI batch keys back to their independent UI drafts", async () => {
    const user = userEvent.setup();
    const api = wizardApi([]);
    vi.mocked(api.searchProducts).mockResolvedValue({ status: "available", candidates: [usCandidate, kirbyCandidate] });
    const names = nameSuggestionApi([]);
    vi.mocked(names.suggestAiNames).mockImplementation(async (candidates) => ({
      suggestions: candidates.map((candidate, index) => ({
        candidateKey: candidate.candidateKey,
        displayNameZhCn: index === 0 ? "AI 胡闹厨房" : "AI 星之卡比",
        confidence: "high" as const,
      })),
    }));

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "two games");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: /Kirby and the Forgotten Land/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    expect(await screen.findByDisplayValue("AI 胡闹厨房")).toBeTruthy();
    expect(screen.getByDisplayValue("AI 星之卡比")).toBeTruthy();
    const sentCandidates = vi.mocked(names.suggestAiNames).mock.calls[0]?.[0] ?? [];
    // 两个本地关联键必须唯一，且整个 AI 请求正文都不能出现任一地区商品 URL 哨兵。
    expect(new Set(sentCandidates.map((candidate) => candidate.candidateKey)).size).toBe(2);
    expect(JSON.stringify(sentCandidates)).not.toContain(usCandidate.productUrl);
    expect(JSON.stringify(sentCandidates)).not.toContain(kirbyCandidate.productUrl);
  });

  it("ignores an old AI batch after a new search creates a newer suggestion generation", async () => {
    const user = userEvent.setup();
    let resolveStaleAi: (value: { suggestions: AiGameNameSuggestion[] }) => void = () => undefined;
    const staleAi = new Promise<{ suggestions: AiGameNameSuggestion[] }>((resolve) => { resolveStaleAi = resolve; });
    const api = wizardApi([]);
    vi.mocked(api.searchProducts)
      .mockResolvedValueOnce({ status: "available", candidates: [usCandidate] })
      .mockResolvedValueOnce({ status: "available", candidates: [kirbyCandidate] });
    const names = nameSuggestionApi([]);
    let firstBatchKey = "";
    vi.mocked(names.suggestAiNames)
      .mockImplementationOnce(async (candidates) => {
        firstBatchKey = candidates[0]?.candidateKey ?? "";
        return staleAi;
      })
      .mockImplementationOnce(async (candidates) => ({
        suggestions: [{ candidateKey: candidates[0]?.candidateKey ?? "missing", displayNameZhCn: "新搜索建议", confidence: "high" }],
      }));

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);
    const query = screen.getByRole("textbox", { name: "游戏名称" });
    await user.type(query, "old search");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));
    await waitFor(() => expect(names.suggestAiNames).toHaveBeenCalledTimes(1));

    await user.clear(query);
    await user.type(query, "new search");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Kirby and the Forgotten Land/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));
    expect(await screen.findByDisplayValue("新搜索建议")).toBeTruthy();

    resolveStaleAi({ suggestions: [{ candidateKey: firstBatchKey, displayNameZhCn: "过期搜索建议", confidence: "high" }] });
    await waitFor(() => expect(screen.queryByDisplayValue("过期搜索建议")).toBeNull());
    // 旧批次即使迟到也不能覆盖新搜索的 UI 键、名称草稿或 AI 来源标记。
    expect(screen.getByDisplayValue("新搜索建议")).toBeTruthy();
    expect(screen.getAllByText("AI 建议，待确认")).toHaveLength(1);
  });

  it("keeps regional results and manual confirmation available when the AI endpoint returns 503", async () => {
    // 该回归在 AI 错误清空地区结果、触发认证壳或禁止原有手工确认路径时失败；503 是可选能力未配置的受控业务状态。
    const user = userEvent.setup();
    const api = wizardApi([]);
    const names = nameSuggestionApi([]);
    vi.mocked(names.suggestAiNames).mockRejectedValue(new GameNameApiError("AI 名称建议尚未配置。", 503));

    render(<SubscriptionWizardPage api={api} gameNameApi={names} onUnauthorized={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "游戏名称" }), "Overcooked! 2");
    await user.click(screen.getByRole("button", { name: "搜索官方商品" }));
    await user.click(await screen.findByRole("button", { name: /Overcooked! 2 – Nintendo Switch 2 Edition/ }));
    await user.click(screen.getByRole("button", { name: "核验其他地区" }));

    expect((await screen.findByRole("status")).textContent).toContain("AI 名称建议尚未配置。");
    const input = screen.getByRole("textbox", { name: `${usCandidate.canonicalTitle} 的简体中文显示名称` });
    await user.type(input, "管理员名称");
    expect((screen.getByRole("button", { name: "确认订阅" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("retries Japanese regional discovery after a safe manual-link message and renders the automatic candidate", async () => {
    // 本地 Playwright 核验暂不可用时必须保留人工链接输入，同时管理员可重新发起同一批安全地区解析；第二次响应只能由服务端自动候选更新页面。
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
      // 第二次请求保持 pending，证明按钮会在本地浏览器重试尚未结算时禁用，不能被连续点击并发消耗 Chromium 资源。
      .mockReturnValueOnce(retryPending);

    render(<SubscriptionWizardPage api={api} gameNameApi={nameSuggestionApi([])} onUnauthorized={vi.fn()} />);

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
    // 搜索会重置地区确认上下文：旧的本地 Playwright 请求即使稍后成功，也不能把自动候选或安全提示写回新搜索；更不能在新一代仍 pending 时错误关闭加载状态。
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

    render(<SubscriptionWizardPage api={api} gameNameApi={nameSuggestionApi([])} onUnauthorized={vi.fn()} />);

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
