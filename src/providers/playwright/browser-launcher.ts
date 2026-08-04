import { chromium } from "playwright";

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

/** 本地启动器以窄对象提供浏览器，便于关系适配器与测试都不依赖完整 Playwright API。 */
export interface BrowserLauncher {
  launch(): Promise<BrowserLike>;
}

/** Playwright 注入面只包含 Chromium 本地 launch；没有 connect、connectOverCDP 或任何远端端点能力。 */
export interface LocalPlaywrightModule {
  chromium: {
    launch(options: { headless: true; executablePath?: string }): Promise<BrowserLike>;
  };
}

/**
 * 创建本地 Chromium 启动器。始终无头、只允许可选本地 executablePath，
 * 不开放调试端口、CDP、持久化上下文或远端浏览器地址，确保 NAS 上的网页关系核验没有外部控制面。
 */
export function createLocalBrowserLauncher(
  options: { executablePath?: string; headless: true },
  playwright: LocalPlaywrightModule = { chromium },
): BrowserLauncher {
  return {
    launch: () => playwright.chromium.launch({
      headless: true,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    }),
  };
}
