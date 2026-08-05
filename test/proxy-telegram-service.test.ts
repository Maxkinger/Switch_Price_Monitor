import { describe, expect, it, vi } from "vitest";
import { ProxyTelegramService } from "../src/services/proxy-telegram-service";

describe("代理 Telegram 适配器", () => {
  it("一次分页投递只创建一次出站快照", async () => {
    // 同一日报的分页必须共享不可变代理配置，不能在两页之间读到不同设置而改变发送出口。
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const snapshot = vi.fn().mockResolvedValue({ fetch: vi.fn(), send });
    const service = new ProxyTelegramService({ botToken: "test-token", chatId: "test-chat" }, { snapshot });
    await service.send([{ text: "一" }, { text: "二" }]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

