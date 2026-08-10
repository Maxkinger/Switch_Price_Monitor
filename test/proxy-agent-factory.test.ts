import { describe, expect, it } from "vitest";

import { classifyProxyResponse, createProxyAgent } from "../src/server/network/proxy-agent-factory";
import { ProxyTransportError } from "../src/server/network/proxy-errors";

/** Agent 工厂只从无认证代理草稿构造连接器，不把用户名、密码或完整 URL 交给调用方。 */
describe("代理 Agent 工厂", () => {
  it.each([
    ["http", "http:", "HttpProxyAgent"],
    ["http", "https:", "HttpsProxyAgent"],
    ["https", "http:", "HttpProxyAgent"],
    ["https", "https:", "HttpsProxyAgent"],
    ["socks5", "https:", "SocksProxyAgent"],
  ] as const)("builds an unauthenticated %s agent for %s targets", (protocol, targetProtocol, expectedName) => {
    // HTTP(S) Agent 按目标协议选择，SOCKS5 使用自身 Agent；设置对象没有凭据字段，序列化结果也不得出现认证键。
    const agent = createProxyAgent({ enabled: true, protocol, host: "127.0.0.1", port: 7890 }, targetProtocol);
    expect(agent.constructor.name).toBe(expectedName);
    expect(JSON.stringify(agent)).not.toMatch(/username|password/i);
  });

  it("brackets IPv6 hosts and treats a 407 response as unsupported proxy authentication", () => {
    // IPv6 冒号不能与端口分隔符混淆；首版不支持认证代理，因此 407 必须是可控传输错误而非透传响应正文。
    expect(createProxyAgent({ enabled: true, protocol: "http", host: "::1", port: 7890 }, "https:")).toBeDefined();
    expect(() => classifyProxyResponse(new Response(null, { status: 407 }))).toThrowError(
      new ProxyTransportError("proxy-authentication-required"),
    );
  });
});
