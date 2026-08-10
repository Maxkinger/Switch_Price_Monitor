import type { ProxyFailureCategory } from "../../server/network/proxy-errors";

/**
 * 浏览器代理传输错误是本地 Chromium 边界的受控标记，不携带 Playwright 原始正文给路由或页面。
 * 关系核验只用它判断是否可以在完成资源清理后直连一次，普通页面解析、超时或业务错误绝不能触发回退。
 */
export class BrowserProxyTransportError extends Error {
  public constructor(public readonly category: ProxyFailureCategory, cause?: unknown) {
    super("浏览器代理连接失败。", cause === undefined ? undefined : { cause });
    this.name = "BrowserProxyTransportError";
  }
}

/** 只识别本模块自己的固定错误类型，防止把任意浏览器异常误判为代理传输问题。 */
export function isBrowserProxyTransportError(error: unknown): error is BrowserProxyTransportError {
  return error instanceof BrowserProxyTransportError;
}
