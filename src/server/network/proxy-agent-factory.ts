import type { Agent } from "node:http";
import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import type { ProxySettings } from "../../shared/proxy-settings";
import { validateProxySettings } from "../../shared/proxy-settings";
import { classifyProxyError, ProxyTransportError } from "./proxy-errors";

/** 标准 Fetch 形状让业务提供方不接触 Node Agent；只有本文件可以把代理设置转换成连接器。 */
export type ProxyFetch = (settings: Readonly<ProxySettings>, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 根据目标协议选择 Node Agent；代理 URL 只由已校验字段生成，不接受完整 URL、用户名或密码。
 * SOCKS5 使用 socks5h，让代理端解析目标域名，避免 NAS 本地 DNS 泄露外部请求目标。
 */
export function createProxyAgent(settings: ProxySettings, targetProtocol: string): Agent {
  if (validateProxySettings(settings) || !["http:", "https:"].includes(targetProtocol)) throw new ProxyTransportError("unknown-transport");
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  const proxyUrl = `${settings.protocol === "socks5" ? "socks5h" : settings.protocol}://${host}:${settings.port}`;
  if (settings.protocol === "socks5") return new SocksProxyAgent(proxyUrl);
  return targetProtocol === "http:" ? new HttpProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

/** 将 407 固定归类为无认证代理不能满足的认证要求；其他响应均是目标业务响应，不能触发回退。 */
export function classifyProxyResponse<TResponse extends { status: number }>(response: TResponse): TResponse {
  if (response.status === 407) throw new ProxyTransportError("proxy-authentication-required");
  return response;
}

/** node-fetch 只在此模块出现，以隔离 Agent 选项和不含底层文本的传输错误映射。 */
export const proxyFetch: ProxyFetch = async (settings, input, init) => {
  const target = readRequestUrl(input);
  try {
    return classifyProxyResponse(await nodeFetch(target, { ...(init as NodeFetchRequestInit), agent: createProxyAgent(settings as ProxySettings, target.protocol) })) as unknown as Response;
  } catch (error) { throw classifyProxyError(error); }
};

/** 相对地址不属于可审计出站目标，代理层必须在构造 Agent 前拒绝。 */
function readRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL((input as { url: string }).url);
}
