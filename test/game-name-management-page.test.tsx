// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameNameApiError, type AiGameNameSuggestion, type GameNameSuggestionCandidate, type PendingGameNameDto } from "../src/app/game-name-api-client";
import { GameNameManagementPage } from "../src/app/game-name-management-page";

/** 待补充夹具包含完整官方身份辅助信息，确保管理页可以区分同名本体、DLC 与不同发行商，而不会把这些字段提升为普通页面主标题。 */
const pendingKirby: PendingGameNameDto = {
  gameId: "game-kirby",
  subscriptionId: "subscription-kirby",
  identityKey: "kirby and the forgotten land|nintendo|game",
  officialTitle: "Kirby and the Forgotten Land",
  publisher: "Nintendo",
  productType: "game",
  legacyNameZh: "星之卡比 探索发现",
};

/**
 * 管理页夹具将 AI 端点与既有保存端点都显式暴露为 spy，保证测试验证真实 UI 结果时，
 * 仍能确认建议请求没有越权写入名称；默认空建议模拟服务端已正常答复但没有可用模型结果。
 */
function managementApi({
  aiSuggestions = [],
  games = [pendingKirby],
  suggestAiNames = vi.fn(async () => ({ suggestions: aiSuggestions })),
}: {
  aiSuggestions?: AiGameNameSuggestion[];
  games?: PendingGameNameDto[];
  // 使用正式函数签名约束夹具，避免 Vitest 无参数 Mock 的宽泛类型掩盖页面端口变更。
  suggestAiNames?: (candidates: GameNameSuggestionCandidate[]) => Promise<{ suggestions: AiGameNameSuggestion[] }>;
} = {}) {
  return {
    listPending: vi.fn(async () => ({ games })),
    backfill: vi.fn(),
    suggestAiNames,
    saveGameName: vi.fn(),
  };
}

/** 管理页每个用例都销毁独立队列与草稿，防止异步 reload 或 422 状态泄漏到下一用例。 */
describe("简体中文名称管理页", () => {
  afterEach(cleanup);

  it("shows pending status and official identity fields only as administrator assistance", async () => {
    const api = {
      listPending: vi.fn(async () => ({ games: [pendingKirby] })),
      backfill: vi.fn(),
      // 非 AI 场景仍提供正式端口，保持管理页依赖完整且避免测试借缺失属性绕过类型合同。
      suggestAiNames: vi.fn(async () => ({ suggestions: [] })),
      saveGameName: vi.fn(),
    };

    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "待补充中文名称" })).toBeTruthy();
    expect(screen.getByText("Kirby and the Forgotten Land")).toBeTruthy();
    expect(screen.getByText("Nintendo")).toBeTruthy();
    expect(screen.getByText("游戏本体")).toBeTruthy();
    expect(screen.getByLabelText("简体中文显示名称")).toHaveProperty("value", "星之卡比 探索发现");
  });

  it("does not report an empty queue when the initial queue read fails", async () => {
    const api = {
      listPending: vi.fn(async () => { throw new Error("offline"); }),
      backfill: vi.fn(),
      suggestAiNames: vi.fn(async () => ({ suggestions: [] })),
      saveGameName: vi.fn(),
    };

    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    expect((await screen.findByRole("status")).textContent).toBe("待补充名称暂时无法读取，请稍后重试。");
    // 网络失败无法证明队列为空；若页面把 settled 与 success 混为一态，本断言会捕获误导性的成功文案。
    expect(screen.queryByText("所有游戏都已有简体中文名称。")).toBeNull();
  });

  it("re-reads the pending queue after catalog backfill succeeds", async () => {
    const user = userEvent.setup();
    const api = {
      listPending: vi.fn()
        .mockResolvedValueOnce({ games: [pendingKirby] })
        .mockResolvedValueOnce({ games: [] }),
      backfill: vi.fn(async () => ({ updatedGameIds: ["game-kirby"], remainingCount: 0 })),
      suggestAiNames: vi.fn(async () => ({ suggestions: [] })),
      saveGameName: vi.fn(),
    };

    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "执行目录回填" }));

    await waitFor(() => expect(api.listPending).toHaveBeenCalledTimes(2));
    expect(screen.getByText("所有游戏都已有简体中文名称。")).toBeTruthy();
  });

  it("keeps the edited draft and shows the API 422 summary when an empty name is rejected", async () => {
    const user = userEvent.setup();
    const api = {
      listPending: vi.fn(async () => ({ games: [pendingKirby] })),
      backfill: vi.fn(),
      suggestAiNames: vi.fn(async () => ({ suggestions: [] })),
      saveGameName: vi.fn(async () => { throw new GameNameApiError("中文显示名称长度应为 1 到 120 个字符。", 422); }),
    };

    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);
    const input = await screen.findByLabelText("简体中文显示名称");
    await user.clear(input);
    await user.click(screen.getByRole("checkbox", { name: "保存为可复用词条" }));
    await user.click(screen.getByRole("button", { name: "保存中文名称" }));

    expect((await screen.findByRole("status")).textContent).toBe("中文显示名称长度应为 1 到 120 个字符。");
    expect(input).toHaveProperty("value", "");
    expect(api.saveGameName).toHaveBeenCalledWith("game-kirby", {
      displayNameZhCn: "",
      source: "manual",
      evidenceUrl: null,
      saveToCatalog: true,
    });
    expect(api.listPending).toHaveBeenCalledTimes(1);
  });

  it("re-reads the queue after one manual name is saved", async () => {
    const user = userEvent.setup();
    const api = {
      listPending: vi.fn()
        .mockResolvedValueOnce({ games: [pendingKirby] })
        .mockResolvedValueOnce({ games: [] }),
      backfill: vi.fn(),
      suggestAiNames: vi.fn(async () => ({ suggestions: [] })),
      saveGameName: vi.fn(async () => ({ gameId: "game-kirby", displayNameZhCn: "星之卡比 探索发现", source: "manual" as const })),
    };

    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "保存中文名称" }));

    await waitFor(() => expect(api.listPending).toHaveBeenCalledTimes(2));
    expect(screen.getByText("所有游戏都已有简体中文名称。")).toBeTruthy();
  });

  it("单行 AI 建议只预填当前草稿，管理员保存前不写入名称", async () => {
    const user = userEvent.setup();
    const api = managementApi({ aiSuggestions: [{ candidateKey: "game-kirby", displayNameZhCn: "星之卡比 探索发现", confidence: "high" }] });
    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "生成 AI 建议" }));

    expect(screen.getByDisplayValue("星之卡比 探索发现")).toBeTruthy();
    expect(screen.getByText("AI 建议，待确认")).toBeTruthy();
    // 建议仅修改浏览器草稿；管理员未点击保存前不得触发任何持久化命令。
    expect(api.saveGameName).not.toHaveBeenCalled();
    expect(api.suggestAiNames).toHaveBeenCalledWith([{
      candidateKey: "game-kirby",
      canonicalTitle: "Kirby and the Forgotten Land",
      publisher: "Nintendo",
      productType: "game",
    }]);
  });

  it("AI 返回前后的人工草稿都优先于建议结果", async () => {
    const user = userEvent.setup();
    let resolveSuggestion: (value: { suggestions: AiGameNameSuggestion[] }) => void = () => undefined;
    const pendingSuggestion = new Promise<{ suggestions: AiGameNameSuggestion[] }>((resolve) => { resolveSuggestion = resolve; });
    const api = managementApi({ suggestAiNames: vi.fn(() => pendingSuggestion) });
    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    const input = await screen.findByLabelText("简体中文显示名称");
    await user.clear(input);
    await user.type(input, "管理员确认名称");
    await user.click(screen.getByRole("button", { name: "生成 AI 建议" }));
    resolveSuggestion({ suggestions: [{ candidateKey: "game-kirby", displayNameZhCn: "星之卡比 探索发现", confidence: "high" }] });

    await waitFor(() => expect(screen.getByLabelText("简体中文显示名称")).toHaveProperty("value", "管理员确认名称"));
    // 已编辑草稿代表明确的人工作业意图，即使网络响应更晚返回也绝不能覆盖。
    expect(screen.queryByText("AI 建议，待确认")).toBeNull();
  });

  it("管理员清空既有名称后，迟到 AI 建议不得把空草稿重新填入", async () => {
    const user = userEvent.setup();
    let resolveSuggestion: (value: { suggestions: AiGameNameSuggestion[] }) => void = () => undefined;
    const pendingSuggestion = new Promise<{ suggestions: AiGameNameSuggestion[] }>((resolve) => { resolveSuggestion = resolve; });
    let aiResponseConsumed = false;
    const api = managementApi({ suggestAiNames: vi.fn(async () => {
      const response = await pendingSuggestion;
      // 只在页面 await 已恢复后置位，防止断言在异步 continuation 消费响应前就错误通过。
      aiResponseConsumed = true;
      return response;
    }) });
    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    const input = await screen.findByLabelText("简体中文显示名称");
    await user.click(screen.getByRole("button", { name: "生成 AI 建议" }));
    await user.clear(input);
    resolveSuggestion({ suggestions: [{ candidateKey: "game-kirby", displayNameZhCn: "星之卡比 探索发现", confidence: "high" }] });

    await waitFor(() => expect(aiResponseConsumed).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "生成 AI 建议" })).toHaveProperty("disabled", false));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    // 既有名称被清空是管理员的明确删除意图，不得误报为 AI 草稿或被迟到响应覆盖。
    expect(screen.queryByText("AI 建议，待确认")).toBeNull();
  });

  it("初始为空且未编辑的草稿仍允许 AI 建议预填", async () => {
    const user = userEvent.setup();
    const api = managementApi({
      games: [{ ...pendingKirby, legacyNameZh: "" }],
      aiSuggestions: [{ candidateKey: "game-kirby", displayNameZhCn: "星之卡比 探索发现", confidence: "high" }],
    });
    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "生成 AI 建议" }));

    // 未被管理员触碰的初始空值不是删除意图，应保留按需建议减少手工录入。
    expect(screen.getByDisplayValue("星之卡比 探索发现")).toBeTruthy();
    expect(screen.getByText("AI 建议，待确认")).toBeTruthy();
  });

  it("AI 服务失败显示脱敏摘要并允许只重试当前行", async () => {
    const user = userEvent.setup();
    const api = managementApi({ suggestAiNames: vi.fn()
      .mockRejectedValueOnce(new GameNameApiError("AI 名称建议暂时不可用。", 503))
      .mockResolvedValueOnce({ suggestions: [{ candidateKey: "game-kirby", displayNameZhCn: "星之卡比 探索发现", confidence: "medium" }] }) });
    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "生成 AI 建议" });
    await user.click(button);
    expect((await screen.findByRole("status")).textContent).toBe("AI 名称建议暂时不可用。");
    expect(button).toHaveProperty("disabled", false);
    await user.click(button);

    await waitFor(() => expect(screen.getByText("AI 建议，待确认")).toBeTruthy());
    expect(api.suggestAiNames).toHaveBeenCalledTimes(2);
  });
});
