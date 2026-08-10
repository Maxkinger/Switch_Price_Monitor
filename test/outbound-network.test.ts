import { describe, expect, it, vi } from "vitest";
import { createOutboundNetwork, type ProxySettingsReader } from "../src/server/network/outbound-network";
import type { ProxyFetch } from "../src/server/network/proxy-agent-factory";
import { ProxyTransportError } from "../src/server/network/proxy-errors";
import type { ProxySettings } from "../src/shared/proxy-settings";

describe("统一出站网络", () => {
  it("代理不可连接时为幂等读取仅直连回退一次", async () => {
    // 读取接口允许一次回退；设置读取本身与外部请求都由替身隔离，测试不访问真实代理或商品站点。
    const directFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const proxyFetch = vi.fn<ProxyFetch>().mockRejectedValue(new ProxyTransportError("connection"));
    const session = await createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch }).snapshot();
    await expect(session.fetch("https://target.test/read")).resolves.toMatchObject({ ok: true });
    expect(proxyFetch).toHaveBeenCalledTimes(1); expect(directFetch).toHaveBeenCalledTimes(1);
  });
  it("代理预检成功后不为非幂等发送执行直连重试", async () => {
    // Telegram POST 已经进入代理通道时结果可能未知，禁止第二次直连以避免重复通知。
    const proxyFetch = vi.fn<ProxyFetch>().mockResolvedValueOnce(new Response(null, { status: 404 })).mockRejectedValueOnce(new ProxyTransportError("unknown-transport"));
    const directFetch = vi.fn<typeof fetch>();
    const session = await createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch }).snapshot();
    await expect(session.send("https://api.telegram.test/bot-secret/sendMessage", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ProxyTransportError);
    expect(directFetch).not.toHaveBeenCalled();
  });
  it("代理关闭时直连且会话只读取一次不可变配置快照", async () => {
    // 设置 PATCH 只能影响下一次业务会话，正在进行的发现或采集不得半途切换出口。
    const readProxySettings = vi.fn<ProxySettingsReader["readProxySettings"]>().mockResolvedValueOnce({ ...disabledProxy() }).mockResolvedValueOnce({ ...enabledProxy() });
    const directFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")); const proxyFetch = vi.fn<ProxyFetch>();
    const network = createOutboundNetwork({ settings: { readProxySettings }, directFetch, proxyFetch }); const first = await network.snapshot();
    await first.fetch("https://target.test/first"); await first.fetch("https://target.test/second"); await (await network.snapshot()).fetch("https://target.test/third");
    expect(readProxySettings).toHaveBeenCalledTimes(2); expect(directFetch).toHaveBeenCalledTimes(2); expect(proxyFetch).toHaveBeenCalledTimes(1);
  });
  it("取消信号已触发时不启动直连回退", async () => {
    // 取消优先于回退，避免关机或超时后的旧任务产生额外直连网络活动。
    const controller = new AbortController(); controller.abort(); const directFetch = vi.fn<typeof fetch>(); const proxyFetch = vi.fn<ProxyFetch>().mockRejectedValue(new ProxyTransportError("connect-timeout"));
    const session = await createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch }).snapshot();
    await expect(session.fetch("https://target.test/read", { signal: controller.signal })).rejects.toBeInstanceOf(ProxyTransportError); expect(directFetch).not.toHaveBeenCalled();
  });
});
function fixedSettings(settings: ProxySettings): ProxySettingsReader { return { readProxySettings: vi.fn().mockResolvedValue({ ...settings }) }; }
function enabledProxy(): ProxySettings { return { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 }; }
function disabledProxy(): ProxySettings { return { ...enabledProxy(), enabled: false }; }
