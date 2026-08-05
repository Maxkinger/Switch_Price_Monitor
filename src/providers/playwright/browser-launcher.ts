import { chromium } from "playwright";

import { classifyProxyError } from "../../server/network/proxy-errors";
import { validateProxySettings, type ProxySettings } from "../../shared/proxy-settings";
import { BrowserProxyTransportError } from "./browser-errors";
export { BrowserProxyTransportError, isBrowserProxyTransportError } from "./browser-errors";

/** 页面能力仅暴露日区升级关系提取所需的导航、定位与关闭操作，禁止业务层读取 Cookie、存储或 CDP 调试会话。 */
export interface BrowserPageLike {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  locator(selector: string): {
    all(): Promise<Array<{
      isVisible(): Promise<boolean>;
      innerText(): Promise<string>;
      getAttribute(name: "href"): Promise<string | null>;
    }>>;
  };
  close(): Promise<void>;
}

/** 每个升级根都必须创建新上下文；接口不提供持久化配置，避免商品间共享会话、缓存或本地存储。 */
export interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

/** 浏览器只允许新建隔离上下文并在批次末尾关闭，调试端口、远端连接和 persistent context 均不在此边界出现。 */
export interface BrowserLike {
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

/** Chromium 启动参数只暴露代理草稿；业务层不能注入 executablePath 以外的调试、持久化或远端连接选项。 */
export interface BrowserLaunchOptions {
  proxy?: ProxySettings;
}

/** 本地启动器以窄对象提供浏览器，便于关系适配器与测试都不依赖完整 Playwright API。 */
export interface BrowserLauncher {
  launch(options?: BrowserLaunchOptions): Promise<BrowserLike>;
}

/** Playwright 注入面只包含 Chromium 本地 launch；没有 connect、connectOverCDP 或任何远端端点能力。 */
export interface LocalPlaywrightModule {
  chromium: {
    launch(options: { headless: true; executablePath?: string; proxy?: { server: string } }): Promise<BrowserLike>;
  };
}

/** 代理配置只在启动器边界转换为 Playwright server；不接收完整 URL、用户名、密码或未知字段。 */
export function toPlaywrightProxy(settings: ProxySettings | undefined): { server: string } | undefined {
  if (settings === undefined || !settings.enabled) return undefined;
  if (validateProxySettings(settings) !== null) throw new BrowserProxyTransportError("unknown-transport");
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return { server: `${settings.protocol}://${host}:${settings.port}` };
}

/**
 * 创建本地 Chromium 启动器。始终无头、只允许可选本地 executablePath，
 * 不开放调试端口、CDP、持久化上下文或远端浏览器地址，确保 NAS 上的网页关系核验没有外部控制面。
 */
export function createLocalBrowserLauncher(
  options: { executablePath?: string; headless: true },
  playwright: LocalPlaywrightModule = { chromium },
): BrowserLauncher {
  // 空白路径不是有效的本地 Chromium 配置；先裁剪仅用于判空，非空可信路径仍原样传给 Playwright，避免误改 NAS 挂载路径。
  const executablePath = options.executablePath?.trim();
  return {
    async launch(launchOptions = {}) {
      const proxy = toPlaywrightProxy(launchOptions.proxy);
      try {
        return await playwright.chromium.launch({
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          ...(proxy ? { proxy } : {}),
        });
      } catch (error) {
        // 只有代理模式把启动失败归为可回退传输错误；关闭代理时保留普通启动失败的安全降级语义。
        if (proxy) {
          const classified = classifyProxyError(error);
          throw new BrowserProxyTransportError(classified.category, error);
        }
        throw error;
      }
    },
  };
}
