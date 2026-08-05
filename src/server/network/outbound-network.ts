import type { ProxySettings } from "../../shared/proxy-settings";
import { validateProxySettings } from "../../shared/proxy-settings";
import { type ProxyFetch, proxyFetch as defaultProxyFetch } from "./proxy-agent-factory";
import { isProxyTransportError, ProxyTransportError } from "./proxy-errors";

/** 传输路径只供服务端诊断和连接测试映射，不得写入业务价格来源或公开底层错误。 */
export type TransportPath = "direct" | "proxy" | "direct-fallback";

/** 一次请求同时返回 HTTP 响应和安全传输路径，调用方仍自行解释 4xx/5xx 等业务响应。 */
export interface OutboundResult {
  response: Response;
  path: TransportPath;
}

/** 设置读取器只暴露代理草稿，防止统一网络层取得 Telegram、认证或完整 AppSettings。 */
export interface ProxySettingsReader {
  readProxySettings(): Promise<ProxySettings>;
}

/**
 * 会话在一次商品发现、采集轮次或 Telegram 投递开始时绑定不可变代理快照。
 * fetch 是无副作用读取边界；send 是非幂等投递边界，必须通过 HEAD 预检控制直连回退。
 */
export interface OutboundNetworkSession {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  send(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** 统一网络服务既能创建业务快照，也能使用未保存草稿执行固定目标连接探测。 */
export interface OutboundNetwork {
  snapshot(): Promise<OutboundNetworkSession>;
  probe(settings: ProxySettings, input: RequestInfo | URL, init?: RequestInit): Promise<OutboundResult>;
}

/** 依赖注入允许测试隔离真实网络；生产默认只在此模块使用标准直连 fetch 和 Node 代理 Fetch。 */
export interface OutboundNetworkDependencies {
  settings: ProxySettingsReader;
  directFetch?: typeof fetch;
  proxyFetch?: ProxyFetch;
}

/**
 * 创建集中式出站网络层。
 * 提供方不得自行读取数据库、环境变量或代理 URL，所有代理优先、直连回退和不可重复发送边界都在此处统一执行。
 */
export function createOutboundNetwork(dependencies: OutboundNetworkDependencies): OutboundNetwork {
  const directFetch = dependencies.directFetch ?? fetch;
  const requestProxy = dependencies.proxyFetch ?? defaultProxyFetch;

  return {
    async snapshot(): Promise<OutboundNetworkSession> {
      const settings = freezeProxySettings(await dependencies.settings.readProxySettings());
      return {
        fetch: async (input, init) => (await requestIdempotent(settings, input, init, directFetch, requestProxy)).response,
        send: async (input, init) => sendNonIdempotent(settings, input, init, directFetch, requestProxy),
      };
    },
    async probe(settings, input, init): Promise<OutboundResult> {
      // 探测显式使用浏览器草稿且不接触设置读取器；路由只能传入代码固定的目标，不能把本服务变成任意转发器。
      return requestIdempotent(freezeProxySettings(settings), input, init, directFetch, requestProxy);
    },
  };
}

/** 无副作用读取在代理传输失败时允许一次顺序直连；目标已返回 HTTP 响应时原样返回，绝不因业务状态码切换出口。 */
async function requestIdempotent(
  settings: Readonly<ProxySettings>,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  directFetch: typeof fetch,
  requestProxy: ProxyFetch,
): Promise<OutboundResult> {
  if (!settings.enabled) return { response: await directFetch(input, init), path: "direct" };
  try {
    return { response: await requestProxy(settings, input, init), path: "proxy" };
  } catch (error) {
    // 非代理业务异常不能被误认为网络故障；取消也优先于回退，防止关闭期间产生额外直连请求。
    if (!isProxyTransportError(error) || init?.signal?.aborted) throw error;
    return { response: await directFetch(input, init), path: "direct-fallback" };
  }
}

/**
 * 非幂等投递先用不含 Token 路径和正文的 HEAD 探测同一 origin。
 * 仅预检未建立代理连接时直连实际请求；真实 POST 已走代理后即使结果不明也不重发，避免 Telegram 重复通知。
 */
async function sendNonIdempotent(
  settings: Readonly<ProxySettings>,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  directFetch: typeof fetch,
  requestProxy: ProxyFetch,
): Promise<Response> {
  if (!settings.enabled) return directFetch(input, init);
  const preflightUrl = `${readRequestUrl(input).origin}/`;
  try {
    await requestProxy(settings, preflightUrl, { method: "HEAD", signal: init?.signal });
  } catch (error) {
    if (!isProxyTransportError(error) || init?.signal?.aborted) throw error;
    return directFetch(input, init);
  }
  return requestProxy(settings, input, init);
}

/** 配置在会话创建时逐字段复制并冻结；后续 PATCH 不能借由共享对象引用改变正在运行的业务轮次。 */
function freezeProxySettings(value: ProxySettings): Readonly<ProxySettings> {
  const validationError = validateProxySettings(value);
  if (validationError) throw new ProxyTransportError("unknown-transport");
  return Object.freeze({
    enabled: value.enabled,
    protocol: value.protocol,
    host: value.host,
    port: value.port,
  });
}

/** 代理预检只能提取同一请求 origin；相对地址会被 URL 拒绝，避免内部调用意外构造不可审计目标。 */
function readRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL((input as { url: string }).url);
}
