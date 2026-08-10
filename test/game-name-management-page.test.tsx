// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameNameApiError, type PendingGameNameDto } from "../src/app/game-name-api-client";
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

/** 管理页每个用例都销毁独立队列与草稿，防止异步 reload 或 422 状态泄漏到下一用例。 */
describe("简体中文名称管理页", () => {
  afterEach(cleanup);

  it("shows pending status and official identity fields only as administrator assistance", async () => {
    const api = {
      listPending: vi.fn(async () => ({ games: [pendingKirby] })),
      backfill: vi.fn(),
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
      saveGameName: vi.fn(async () => ({ gameId: "game-kirby", displayNameZhCn: "星之卡比 探索发现", source: "manual" as const })),
    };

    render(<GameNameManagementPage api={api} onUnauthorized={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "保存中文名称" }));

    await waitFor(() => expect(api.listPending).toHaveBeenCalledTimes(2));
    expect(screen.getByText("所有游戏都已有简体中文名称。")).toBeTruthy();
  });
});
