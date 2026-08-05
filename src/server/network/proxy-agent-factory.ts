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
  const validationError = validateProxySettings(settings);
  if (validationError) throw new ProxyTransportError("unknown-transport");
  if (targetProtocol !== "http:" && targetProtocol !== "https:") throw new ProxyTransportError("unknown-transport");
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  const proxyUrl = `${settings.protocol === "socks5" ? "socks5h" : settings.protocol}://${host}:${settings.port}`;
  if (settings.protocol === "socks5") return new SocksProxyAgent(proxyUrl);
  return targetProtocol === "http:" ? new HttpProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
}

/** 将代理返回的 407 归类为固定错误；其他 HTTP 响应属于目标业务结果，不得触发通用直连回退。 */
export function classifyProxyResponse<TResponse extends { status: number }>(response: TResponse): TResponse {
  if (response.status === 407) throw new ProxyTransportError("proxy-authentication-required");
  return response;
}

/**
 * node-fetch 只在该模块出现，为现有提供方提供标准 Fetch 返回值并隔离 Agent 选项。
 * 代理请求异常会被转换成不含底层文本的安全错误；TLS 校验保持系统默认，禁止以关闭校验掩盖代理证书问题。
 */
export const proxyFetch: ProxyFetch = async (settings, input, init) => {
  const target = readRequestUrl(input);
  try {
    const response = await nodeFetch(target, {
      ...(init as NodeFetchRequestInit),
      agent: createProxyAgent(settings as ProxySettings, target.protocol),
    });
    return classifyProxyResponse(response) as unknown as Response;
  } catch (error) {
    throw classifyProxyError(error);
  }
};

/** 从三种 Fetch 输入形式提取 URL；不能接受不存在 scheme 的相对地址，避免代理层构造出不可审计目标。 */
function readRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  const request = input as { url: string };
  return new URL(request.url);
}

