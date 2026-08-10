import { describe, expect, it, vi } from "vitest";

import { createApiRequestTracker } from "../src/app/api-request-tracker";
import { GameNameApiError, createGameNameApiClient } from "../src/app/game-name-api-client";

/**
 * 名称客户端测试把 fetch 固定在内存边界，确保四个管理员端点始终使用同源 Cookie，
 * 且名称、证据和复用选择只进入受控 JSON；测试不得访问真实数据库、公开证据站或管理员会话。
 */
describe("game name API client", () => {
  it("uses the four same-origin game-name contracts without exposing credentials", async () => {
    const request = vi.fn(async () => Response.json({ games: [], suggestions: [] })) as unknown as typeof fetch;
    const client = createGameNameApiClient(request);

    await client.listPending();
    await client.backfill();
    await client.suggestNames([{ candidateKey: "kirby", canonicalTitle: "Kirby", publisher: "Nintendo", productType: "game" }]);
    await client.saveGameName("game/kirby", { displayNameZhCn: "星之卡比", source: "manual", evidenceUrl: null, saveToCatalog: true });

    expect(request).toHaveBeenNthCalledWith(1, "/api/game-names?status=pending", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    expect(request).toHaveBeenNthCalledWith(2, "/api/game-names/backfill", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(request).toHaveBeenNthCalledWith(3, "/api/game-names/suggestions", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ candidates: [{ candidateKey: "kirby", canonicalTitle: "Kirby", publisher: "Nintendo", productType: "game" }] }) }));
    expect(request).toHaveBeenNthCalledWith(4, "/api/game-names/game%2Fkirby", expect.objectContaining({ method: "PATCH", credentials: "same-origin", body: JSON.stringify({ displayNameZhCn: "星之卡比", source: "manual", evidenceUrl: null, saveToCatalog: true }) }));
  });

  it("keeps a validation summary and balances the global request tracker", async () => {
    const tracker = createApiRequestTracker();
    const request = vi.fn(async () => Response.json({ error: "中文显示名称长度应为 1 到 120 个字符。" }, { status: 422 })) as unknown as typeof fetch;

    await expect(createGameNameApiClient(request, tracker).saveGameName("game-kirby", { displayNameZhCn: "", source: "manual", evidenceUrl: null, saveToCatalog: false }))
      .rejects.toEqual(new GameNameApiError("中文显示名称长度应为 1 到 120 个字符。", 422));
    // 失败响应也必须在 finally 中释放全局遮罩，避免可修正的 422 把整个管理界面永久锁住。
    expect(tracker.getPendingCount()).toBe(0);
  });
});
