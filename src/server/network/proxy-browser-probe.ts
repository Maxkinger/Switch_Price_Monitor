import { classifyProxyError } from "./proxy-errors";
import type { ProxySettings } from "../../shared/proxy-settings";
import {
  type BrowserContextLike,
  type BrowserLauncher,
  type BrowserLike,
  type BrowserPageLike,
} from "../../providers/playwright/browser-launcher";
import { BrowserProxyTransportError, isBrowserProxyTransportError } from "../../providers/playwright/browser-errors";
import type { ProxyBrowserConnectionProbe, ProxyConnectionTestStatus } from "../../services/proxy-connection-test-service";

/**
 * Node 专用 Chromium 固定目标探测器。该文件不能被 Worker 路由直接导入；它只在 PostgreSQL/NAS 装配时注入设置测试服务。
 * 代理导航失败会在 page/context/browser 完整关闭后直连一次，任何页面响应（包括 4xx/5xx）都视为传输已建立。
 */
export function createProxyBrowserConnectionProbe(launcher: BrowserLauncher, timeoutMs = 8_000): ProxyBrowserConnectionProbe {
  return {
    async probe(settings, target, signal) {
      if (signal.aborted) return "failed";
      try {
        await runBrowserProbe(launcher, settings, target, signal, timeoutMs);
        return "proxy-success";
      } catch (error) {
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

/** 单次浏览器探测的资源树严格按 page → context → browser 关闭；直连启动只能发生在该屏障完成之后。 */
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
    if (signal.aborted) throw new Error("aborted");
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (signal.aborted) throw new Error("aborted");
  } catch (error) {
    if (proxyMode && !isBrowserProxyTransportError(error) && !(error instanceof Error && error.name === "TimeoutError")) {
      const classified = classifyProxyError(error);
      throw new BrowserProxyTransportError(classified.category, error);
    }
    throw error;
  } finally {
    await closeSafely(page);
    await closeSafely(context);
    await closeSafely(browser);
  }
}

/** 探测清理失败不把底层正文带入 API；调用方只会看到该通道失败并按既有直连规则结束。 */
async function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<void> {
  if (resource === undefined) return;
  try {
    await resource.close();
  } catch {
    // 连接测试的业务结论不依赖关闭错误；资源释放仍按顺序尽力完成，错误正文禁止出现在响应或日志。
  }
}

