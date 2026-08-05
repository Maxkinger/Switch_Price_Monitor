import { afterEach, describe, expect, it } from "vitest";

import { createProxyAgent, classifyProxyResponse } from "../src/server/network/proxy-agent-factory";
import { proxyFetch } from "../src/server/network/proxy-agent-factory";
import { ProxyTransportError } from "../src/server/network/proxy-errors";
import { startHttpProxyFixture, startSocks5ProxyFixture, startTargetFixture, type RunningFixture } from "./support/proxy-fixtures";

describe("代理 Agent 工厂", () => {
  const running: RunningFixture[] = [];

  afterEach(async () => {
    // 夹具只绑定回环随机端口；每轮等待监听器和活动 socket 关闭，避免代理测试污染其他 Vitest 文件。
    await Promise.all(running.splice(0).map((fixture) => fixture.close()));
  });

  it.each([
    ["http", "http:", "HttpProxyAgent"],
    ["http", "https:", "HttpsProxyAgent"],
    ["https", "http:", "HttpProxyAgent"],
    ["https", "https:", "HttpsProxyAgent"],
    ["socks5", "https:", "SocksProxyAgent"],
  ] as const)("为 %s 代理和 %s 目标构造无认证 %s", (protocol, targetProtocol, expectedName) => {
    // HTTP(S) Agent 类型由目标协议决定，代理 scheme 只能来自已校验设置；工厂不接受用户名、密码或完整 URL。
    const agent = createProxyAgent({ enabled: true, protocol, host: "127.0.0.1", port: 7890 }, targetProtocol);
    expect(agent.constructor.name).toBe(expectedName);
    expect(JSON.stringify(agent)).not.toMatch(/username|password/i);
  });

  it("为 IPv6 代理主机构造方括号地址", () => {
    // IPv6 的冒号属于地址本身而不是端口分隔符；统一补方括号才能避免 Agent 将地址误解析成非法 URL。
    const agent = createProxyAgent({ enabled: true, protocol: "http", host: "::1", port: 7890 }, "https:");
    expect(agent).toBeDefined();
  });

  it("将代理 407 响应分类为固定认证错误", () => {
    // 代理认证首版不支持；407 仍允许出站层按规则尝试一次直连，但底层响应正文和代理地址不能进入公开错误。
    expect(() => classifyProxyResponse(new Response(null, { status: 407 }))).toThrowError(
      new ProxyTransportError("proxy-authentication-required"),
    );
  });

  it("通过本机无认证 HTTP 代理取得目标响应", async () => {
    // 协议冒烟只访问 127.0.0.1；目标和代理均为测试夹具，验证真实 Agent 转发而不暴露 NAS 或公网流量。
    const target = await startTargetFixture();
    const proxy = await startHttpProxyFixture();
    running.push(target, proxy);

    await expect(proxyFetch(
      { enabled: true, protocol: "http", host: "127.0.0.1", port: Number(new URL(proxy.url).port) },
      `${target.url}/robots.txt`,
    )).resolves.toMatchObject({ status: 200 });
  });

  it("通过本机无认证 SOCKS5 代理取得目标响应", async () => {
    // SOCKS5 冒烟验证代理端建连路径；目标仍限制为本机回环，测试不使用任何真实代理或外部 DNS。
    const target = await startTargetFixture();
    const proxy = await startSocks5ProxyFixture();
    running.push(target, proxy);

    await expect(proxyFetch(
      { enabled: true, protocol: "socks5", host: "127.0.0.1", port: Number(new URL(proxy.url).port) },
      `${target.url}/robots.txt`,
    )).resolves.toMatchObject({ status: 200 });
  });
});
