import { chromium } from "playwright";

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
    }): Promise<BrowserLike>;
  };
}

/** 生产配置只允许无头模式和可选本地可执行文件；不接受调试端口、用户数据目录、代理或远程 endpoint。 */
export interface LocalBrowserLaunchOptions {
  executablePath?: string;
  headless: true;
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
    async launch(): Promise<BrowserLike> {
      // 这里是源码唯一允许触达 Playwright 的位置；异常原样交给关系 adapter 映射为固定业务失败，禁止在此记录正文。
      return await playwrightModule.chromium.launch(launchOptions);
    },
  };
}
