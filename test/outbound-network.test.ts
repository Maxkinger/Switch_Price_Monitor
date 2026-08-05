import { describe, expect, it, vi } from "vitest";

import { createOutboundNetwork, type ProxySettingsReader } from "../src/server/network/outbound-network";
import type { ProxyFetch } from "../src/server/network/proxy-agent-factory";
import { ProxyTransportError } from "../src/server/network/proxy-errors";
import type { ProxySettings } from "../src/shared/proxy-settings";

describe("统一出站网络", () => {
  it("代理不可连接时为幂等提供方读取仅直连回退一次", async () => {
    // 商品读取即使用 POST 也没有外部副作用；调用方选择 fetch 语义后，代理传输失败只允许一次直连回退。
    const directFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const proxyFetch = vi.fn<ProxyFetch>().mockRejectedValue(new ProxyTransportError("connection"));
    const network = createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch });
    const session = await network.snapshot();

    await expect(session.fetch("https://target.test/read", { method: "POST", body: "{}" })).resolves.toMatchObject({ ok: true });
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("代理预检成功后不为非幂等发送执行直连重试", async () => {
    // HEAD 仅证明代理当前可达；真实 Telegram POST 一旦开始，结果不明时再直连会造成重复通知。
    const proxyFetch = vi.fn<ProxyFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new ProxyTransportError("unknown-transport"));
    const directFetch = vi.fn<typeof fetch>();
    const network = createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch });
    const session = await network.snapshot();

    await expect(session.send("https://api.telegram.test/bot-secret/sendMessage", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ProxyTransportError);
    expect(proxyFetch).toHaveBeenNthCalledWith(1, enabledProxy(), "https://api.telegram.test/", expect.objectContaining({ method: "HEAD" }));
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("代理关闭时直接请求，且一个会话只读取一次不可变配置快照", async () => {
    // 设置更新只影响后续业务轮次；当前发现或采集会话必须固定在开始时读到的关闭状态，不能执行中切换代理。
    const readProxySettings = vi.fn<ProxySettingsReader["readProxySettings"]>()
      .mockResolvedValueOnce({ ...disabledProxy() })
      .mockResolvedValueOnce({ ...enabledProxy() });
    const directFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const proxyFetch = vi.fn<ProxyFetch>();
    const network = createOutboundNetwork({ settings: { readProxySettings }, directFetch, proxyFetch });
    const first = await network.snapshot();
    await first.fetch("https://target.test/first");
    await first.fetch("https://target.test/second");
    const second = await network.snapshot();
    await second.fetch("https://target.test/third");

    expect(readProxySettings).toHaveBeenCalledTimes(2);
    expect(directFetch).toHaveBeenCalledTimes(2);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it("取消信号已触发时不启动直连回退", async () => {
    // 关机、请求超时或管理员取消优先于回退，避免原任务已终止后额外创建直连网络活动。
    const controller = new AbortController();
    controller.abort();
    const directFetch = vi.fn<typeof fetch>();
    const proxyFetch = vi.fn<ProxyFetch>().mockRejectedValue(new ProxyTransportError("connect-timeout"));
    const network = createOutboundNetwork({ settings: fixedSettings(enabledProxy()), directFetch, proxyFetch });
    const session = await network.snapshot();

    await expect(session.fetch("https://target.test/read", { signal: controller.signal })).rejects.toBeInstanceOf(ProxyTransportError);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("探测草稿不读取或写入持久化设置，并返回直连回退路径", async () => {
    // 连接测试可使用未保存草稿，但不能让草稿污染数据库；返回路径仅供 API 安全地映射中文三态结果。
    const readProxySettings = vi.fn<ProxySettingsReader["readProxySettings"]>();
    const directFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const proxyFetch = vi.fn<ProxyFetch>().mockRejectedValue(new ProxyTransportError("dns"));
    const network = createOutboundNetwork({ settings: { readProxySettings }, directFetch, proxyFetch });

    await expect(network.probe(enabledProxy(), "https://target.test/robots.txt")).resolves.toMatchObject({ path: "direct-fallback" });
    expect(readProxySettings).not.toHaveBeenCalled();
  });
});

/** 读取端口替身每次返回独立对象，验证出站层自行冻结快照而不借助测试对象引用。 */
function fixedSettings(settings: ProxySettings): ProxySettingsReader {
  return { readProxySettings: vi.fn().mockResolvedValue({ ...settings }) };
}

/** 启用代理使用文档保留地址，测试只传给注入的 mock，不会建立真实网络连接。 */
function enabledProxy(): ProxySettings {
  return { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 };
}

/** 关闭状态仍保持完整合法草稿，防止以后启用时绕过相同输入约束。 */
function disabledProxy(): ProxySettings {
  return { ...enabledProxy(), enabled: false };
}

