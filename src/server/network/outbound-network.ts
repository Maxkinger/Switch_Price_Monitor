import type { ProxySettings } from "../../shared/proxy-settings";
import { validateProxySettings } from "../../shared/proxy-settings";
import { type ProxyFetch, proxyFetch as defaultProxyFetch } from "./proxy-agent-factory";
import { isProxyTransportError, ProxyTransportError } from "./proxy-errors";

/** 传输路径只用于服务端诊断与连接测试，不能写入价格来源或返回底层异常。 */
export type TransportPath = "direct" | "proxy" | "direct-fallback";
export interface OutboundResult { response: Response; path: TransportPath; }
export interface ProxySettingsReader { readProxySettings(): Promise<ProxySettings>; }
export interface OutboundNetworkSession { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; send(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }
export interface OutboundNetwork { snapshot(): Promise<OutboundNetworkSession>; probe(settings: ProxySettings, input: RequestInfo | URL, init?: RequestInit): Promise<OutboundResult>; }
export interface OutboundNetworkDependencies { settings: ProxySettingsReader; directFetch?: typeof fetch; proxyFetch?: ProxyFetch; }

/** 集中式出站层统一代理优先、一次直连回退与非幂等发送边界，提供方不得自行读取代理设置。 */
export function createOutboundNetwork(dependencies: OutboundNetworkDependencies): OutboundNetwork {
  const directFetch = dependencies.directFetch ?? fetch;
  const requestProxy = dependencies.proxyFetch ?? defaultProxyFetch;
  return {
    async snapshot() {
      const settings = freezeProxySettings(await dependencies.settings.readProxySettings());
      return { fetch: async (input, init) => (await requestIdempotent(settings, input, init, directFetch, requestProxy)).response, send: (input, init) => sendNonIdempotent(settings, input, init, directFetch, requestProxy) };
    },
    probe: (settings, input, init) => requestIdempotent(freezeProxySettings(settings), input, init, directFetch, requestProxy),
  };
}

/** 幂等读取只在代理传输失败且请求未取消时直连一次；收到任意 HTTP 响应都不改变出口。 */
async function requestIdempotent(settings: Readonly<ProxySettings>, input: RequestInfo | URL, init: RequestInit | undefined, directFetch: typeof fetch, requestProxy: ProxyFetch): Promise<OutboundResult> {
  if (!settings.enabled) return { response: await directFetch(input, init), path: "direct" };
  try { return { response: await requestProxy(settings, input, init), path: "proxy" }; }
  catch (error) { if (!isProxyTransportError(error) || init?.signal?.aborted) throw error; return { response: await directFetch(input, init), path: "direct-fallback" }; }
}

/** 非幂等投递仅在代理预检未建连时直连；真实请求走代理后的结果不明时禁止重发。 */
async function sendNonIdempotent(settings: Readonly<ProxySettings>, input: RequestInfo | URL, init: RequestInit | undefined, directFetch: typeof fetch, requestProxy: ProxyFetch): Promise<Response> {
  if (!settings.enabled) return directFetch(input, init);
  try { await requestProxy(settings, `${readRequestUrl(input).origin}/`, { method: "HEAD", signal: init?.signal }); }
  catch (error) { if (!isProxyTransportError(error) || init?.signal?.aborted) throw error; return directFetch(input, init); }
  return requestProxy(settings, input, init);
}

/** 业务会话读取后冻结副本，避免设置 PATCH 改变正在进行的采集或投递。 */
function freezeProxySettings(value: ProxySettings): Readonly<ProxySettings> {
  if (validateProxySettings(value)) throw new ProxyTransportError("unknown-transport");
  return Object.freeze({ enabled: value.enabled, protocol: value.protocol, host: value.host, port: value.port });
}
function readRequestUrl(input: RequestInfo | URL): URL { return input instanceof URL ? input : typeof input === "string" ? new URL(input) : new URL((input as { url: string }).url); }
