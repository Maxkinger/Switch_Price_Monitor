import { describe, expect, it, vi } from "vitest";

import { ProxyTelegramService } from "../src/services/proxy-telegram-service";

/** Telegram 分页必须在整次投递开始时取得同一代理快照，避免中途设置变更导致同一日报分裂出口。 */
describe("代理 Telegram 适配器", () => {
  it("creates one outbound snapshot for a paginated delivery", async () => {
    // 固定假 token/chat id 只验证依赖边界；不会请求 Telegram、打印凭据或构造任何真实会话。
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const snapshot = vi.fn().mockResolvedValue({ fetch: vi.fn(), send });
    const service = new ProxyTelegramService({ botToken: "test-token", chatId: "test-chat" }, { snapshot });

    await service.send([{ text: "一" }, { text: "二" }]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
