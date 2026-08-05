import type { ProxyFailureCategory } from "../../server/network/proxy-errors";

/**
 * 浏览器代理传输错误的纯领域标记，不依赖 Playwright 或 Node 模块。
 * Worker 只需要加载日区关系服务的安全降级逻辑，因此该错误必须与本地 Chromium 启动器分离，避免 Cloudflare 构建误引入 node:process。
 */
export class BrowserProxyTransportError extends Error {
  public constructor(public readonly category: ProxyFailureCategory, cause?: unknown) {
    super("浏览器代理连接失败。", cause === undefined ? undefined : { cause });
    this.name = "BrowserProxyTransportError";
  }
}

/** 只识别代码自有错误标记，普通页面解析、身份不匹配和超时不得触发直连回退。 */
export function isBrowserProxyTransportError(error: unknown): error is BrowserProxyTransportError {
  return error instanceof BrowserProxyTransportError;
}

