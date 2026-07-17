import { describe, expect, it, vi } from "vitest";

import { TelegramService } from "../src/worker/services/telegram-service";

describe("TelegramService", () => {
  it("sends report pages in order and returns safe per-page results without exposing credentials", async () => {
    // 日报分页的顺序就是阅读顺序；即使中间一页失败也继续尝试后续页，并且结果绝不能包含 Bot Token 或 Chat ID。
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }));
    const telegram = new TelegramService({ botToken: "bot-token-must-not-leak", chatId: "chat-id-must-not-leak", fetcher });

    const results = await telegram.send([{ text: "第 1/2 页" }, { text: "第 2/2 页" }]);

    expect(fetcher).toHaveBeenNthCalledWith(1, "https://api.telegram.org/botbot-token-must-not-leak/sendMessage", expect.objectContaining({ method: "POST" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.telegram.org/botbot-token-must-not-leak/sendMessage", expect.objectContaining({ method: "POST" }));
    expect(results).toEqual([
      { index: 0, delivered: true, status: 200 },
      { index: 1, delivered: false, status: 400 },
    ]);
    expect(JSON.stringify(results)).not.toContain("bot-token-must-not-leak");
    expect(JSON.stringify(results)).not.toContain("chat-id-must-not-leak");
  });
});
