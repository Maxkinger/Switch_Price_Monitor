import type { BrowserContextLike, BrowserLauncher, BrowserLike, BrowserPageLike } from "../../providers/playwright/japanese-upgrade-browser";
import { BrowserProxyTransportError, isBrowserProxyTransportError } from "../../providers/playwright/browser-errors";
import type { ProxyBrowserConnectionProbe, ProxyConnectionTestStatus } from "../../services/proxy-connection-test-service";
import type { ProxySettings } from "../../shared/proxy-settings";
import { classifyProxyError } from "./proxy-errors";

/**
 * Node 专用 Chromium 固定目标探测器只由服务器装配注入，设置路由本身不直接持有 Playwright。
 * 管理员无法指定 URL；代理导航异常只有在完整关闭 page、context、browser 后才允许一次直连回退。
 */
export function createProxyBrowserConnectionProbe(
  launcher: BrowserLauncher,
  timeoutMs = 8_000,
): ProxyBrowserConnectionProbe {
  return {
    async probe(settings, target, signal): Promise<ProxyConnectionTestStatus> {
      if (signal.aborted) return "failed";
      try {
        await runBrowserProbe(launcher, settings, target, signal, timeoutMs);
        return "proxy-success";
      } catch (error) {
        // 只有显式代理传输失败且测试未超时，才可做一次直连；普通页面或 Chromium 故障不扩大网络请求。
        if (!isBrowserProxyTransportError(error) || signal.aborted) return "failed";
        try {
          await runBrowserProbe(launcher, { ...settings, enabled: false }, target, signal, timeoutMs);
          return "direct-fallback-success";
        } catch {
          return "failed";
        }
      }
    },
  };
}

/** 单次探测的所有资源按 page → context → browser 顺序释放，保证回退时没有代理会话残留。 */
async function runBrowserProbe(
  launcher: BrowserLauncher,
  settings: ProxySettings,
  target: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  let browser: BrowserLike | undefined;
  let context: BrowserContextLike | undefined;
  let page: BrowserPageLike | undefined;
  const proxyMode = settings.enabled;
  try {
    browser = await launcher.launch(proxyMode ? { proxy: settings } : undefined);
    if (signal.aborted) throw new Error("PROXY_BROWSER_PROBE_ABORTED");
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (signal.aborted) throw new Error("PROXY_BROWSER_PROBE_ABORTED");
  } catch (error) {
    // 启动器已标记的代理错误保持原样；导航层的网络错误需要在代理模式下归类，超时则不触发直连。
    if (proxyMode && !isBrowserProxyTransportError(error) && !(error instanceof Error && error.name === "TimeoutError")) {
      throw new BrowserProxyTransportError(classifyProxyError(error).category, error);
    }
    throw error;
  } finally {
    await closeSafely(page);
    await closeSafely(context);
    await closeSafely(browser);
  }
}

/** 清理失败不能把底层路径、会话或异常正文带进 API；仍继续释放下一层拥有的资源。 */
async function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<void> {
  if (resource === undefined) return;
  try {
    await resource.close();
  } catch {
    // 测试业务结论只反映连通性，关闭失败不改变已确定的安全三态。
  }
}
