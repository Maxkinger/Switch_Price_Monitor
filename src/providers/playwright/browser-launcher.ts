import { chromium } from "playwright";

import { classifyProxyError } from "../../server/network/proxy-errors";
import { validateProxySettings, type ProxySettings } from "../../shared/proxy-settings";
import { BrowserProxyTransportError } from "./browser-errors";
export { BrowserProxyTransportError, isBrowserProxyTransportError } from "./browser-errors";
import type {
  BrowserLauncher,
  BrowserLike,
} from "./japanese-upgrade-browser";

/**
 * launcher 只需要 Playwright 的本地 Chromium 启动面。
 * 不暴露 connect、connectOverCDP、launchPersistentContext 或 browser server，避免调用方恢复远程端点、持久目录和跨请求会话。
 */
export interface LocalPlaywrightModule {
  chromium: {
    launch(options: {
      headless: true;
      executablePath?: string;
      proxy?: { server: string };
    }): Promise<BrowserLike>;
  };
}

/** 生产配置只允许无头模式和可选本地可执行文件；不接受调试端口、用户数据目录、代理或远程 endpoint。 */
export interface LocalBrowserLaunchOptions {
  executablePath?: string;
  headless: true;
}

/**
 * 代理草稿只在此处转换为 Playwright 的 server 字段；用户名、密码和完整代理 URL 均不属于领域模型。
 * IPv6 在 URL 表示中必须加方括号，但数据库和设置页继续保存裸主机，避免不同网络消费者产生不一致端点。
 */
export function toPlaywrightProxy(settings: ProxySettings | undefined): { server: string } | undefined {
  if (settings === undefined || !settings.enabled) return undefined;
  if (validateProxySettings(settings) !== null) throw new BrowserProxyTransportError("unknown-transport");
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return { server: `${settings.protocol}://${host}:${settings.port}` };
}

/**
 * 创建每批按需启动的本地 Chromium launcher。
 * 第二参数仅用于把最窄 Playwright 模块注入单元测试；生产装配省略它并固定调用本模块静态导入的 `chromium.launch`。
 */
export function createLocalBrowserLauncher(
  options: LocalBrowserLaunchOptions,
  playwrightModule: LocalPlaywrightModule = { chromium },
): BrowserLauncher {
  const executablePath = options.executablePath?.trim();
  const launchOptions = executablePath === undefined || executablePath === ""
    ? { headless: true as const }
    : {
        headless: true as const,
        // 保留可信配置的原始非空路径，不展开环境变量、不解析相对位置，也不写入日志或错误响应。
        executablePath: options.executablePath as string,
      };
  return {
    async launch(options = {}): Promise<BrowserLike> {
      const proxy = toPlaywrightProxy(options.proxy);
      try {
        // 这里是源码唯一允许触达 Playwright 的位置；除明确代理 server 外不开放任何浏览器控制面。
        return await playwrightModule.chromium.launch({ ...launchOptions, ...(proxy === undefined ? {} : { proxy }) });
      } catch (error) {
        // 只有已启用代理时的启动故障可被上层回退；直连 Chromium 故障保持原有安全降级语义。
        if (proxy !== undefined) throw new BrowserProxyTransportError(classifyProxyError(error).category, error);
        throw error;
      }
    },
  };
}
