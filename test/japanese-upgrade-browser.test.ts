import { describe, expect, it, vi } from "vitest";

import type { JapaneseUpgradeRootCandidate } from "../src/worker/providers/official-japanese-upgrade-root";
import {
  createJapaneseUpgradeBrowserBatch,
  normalizeJapaneseUpgradeUrl,
} from "../src/worker/providers/japanese-upgrade-browser";

/**
 * Browser Run 批处理器测试只使用窄内存替身，不得启动真实浏览器或访问任天堂网络。
 * 这样既能稳定证明每个候选的无痕隔离和关闭顺序，也避免测试采集页面、Cookie 或会话数据。
 */
describe("Japanese upgrade Browser Run batch", () => {
  it("uses one browser and a fresh serial context for every valid root", async () => {
    // 两个根必须共享一次请求级浏览器，但上下文和页面必须逐项新建，禁止跨商品复用缓存或登录状态。
    const events: string[] = [];
    const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => fakeBrowser(events, [
      [visibleUpgradeLink("https://store-jp.nintendo.com/item/software/D70050000064985")],
      [visibleUpgradeLink("https://store-jp.nintendo.com/item/software/D70050000064986/")],
    ]));

    const result = await batch.resolve([
      root("https://store-jp.nintendo.com/item/software/D70010000106252/"),
      root("https://store-jp.nintendo.com/item/software/D70010000106253/"),
    ], new AbortController().signal);

    expect([...result.values()]).toEqual([
      { status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" },
      { status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064986/" },
    ]);
    expect(events).toEqual([
      "launch", "context:1", "page:1", "goto:1:https://store-jp.nintendo.com/item/software/D70010000106252/:30000",
      "page-close:1", "context-close:1", "context:2", "page:2", "goto:2:https://store-jp.nintendo.com/item/software/D70010000106253/:30000",
      "page-close:2", "context-close:2", "browser-close",
    ]);
  });

  it("returns an empty map without launching for an empty request", async () => {
    // 空批次不应消耗 Browser Run 启动配额；这也是避免无业务输入仍创建会话的资源边界。
    const launchBrowser = vi.fn();
    const result = await createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser).resolve([], new AbortController().signal);

    expect(result).toEqual(new Map());
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("fails an invalid root without launching or navigating it", async () => {
    // 根 URL 虽通常来自上游官方解析器，适配器仍必须自行拒绝 query，防止未来调用方把它变成 SSRF 导航入口。
    const launchBrowser = vi.fn();
    const unsafeRoot = "https://store-jp.nintendo.com/item/software/D70010000106252/?next=https://evil.example";
    const result = await createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser)
      .resolve([root(unsafeRoot)], new AbortController().signal);

    expect(result.get(unsafeRoot)).toEqual({ status: "browser-unavailable" });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("rejects a root URL with a trailing newline before launch", async () => {
    // JavaScript 的 `$` 会在末尾换行前匹配；根地址必须整串精确匹配，避免换行后的附加输入绕过启动前 SSRF 白名单。
    const launchBrowser = vi.fn();
    const unsafeRoot = "https://store-jp.nintendo.com/item/software/D70010000106252/\n";
    const result = await createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser)
      .resolve([root(unsafeRoot)], new AbortController().signal);

    expect(result.get(unsafeRoot)).toEqual({ status: "browser-unavailable" });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("keeps invalid roots out of a mixed batch while resolving valid roots", async () => {
    // 一个坏输入只能得到自身的安全失败；同批其余已验证根仍可按串行隔离流程完成，不能被错误 URL 带偏。
    const events: string[] = [];
    const unsafeRoot = "https://evil.example/item/software/D70010000106252/";
    const validRoot = "https://store-jp.nintendo.com/item/software/D70010000106253";
    const result = await createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => fakeBrowser(events, [
      [visibleUpgradeLink("/item/software/D70050000064985/")],
    ])).resolve([root(unsafeRoot), root(validRoot)], new AbortController().signal);

    expect(result.get(unsafeRoot)).toEqual({ status: "browser-unavailable" });
    expect(result.get(validRoot)).toEqual({ status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" });
    expect(events).toEqual([
      "launch", "context:1", "page:1", "goto:1:https://store-jp.nintendo.com/item/software/D70010000106253:30000",
      "page-close:1", "context-close:1", "browser-close",
    ]);
  });

  it.each([
    ["http", "http://store-jp.nintendo.com/item/software/D70050000064985/"],
    ["wrong host", "https://evil.example/item/software/D70050000064985/"],
    ["query", "https://store-jp.nintendo.com/item/software/D70050000064985/?token=x"],
    ["fragment", "https://store-jp.nintendo.com/item/software/D70050000064985/#x"],
    ["port", "https://store-jp.nintendo.com:8443/item/software/D70050000064985/"],
    ["credentials", "https://user:pass@store-jp.nintendo.com/item/software/D70050000064985/"],
    ["wrong path", "https://store-jp.nintendo.com/item/aocs/D70050000064985/"],
  ])("rejects %s target URL", (_name, url) => {
    // 目标链接只能是受控日区软件路径；协议、主机、认证信息和 URL 附加部分都不得成为隐式跳转通道。
    expect(normalizeJapaneseUpgradeUrl(url)).toBeNull();
  });

  it("accepts a same-site relative target and deduplicates repeated official links", async () => {
    // DOM 中重复的同一官方链接不应误判为多个候选；相对路径只在固定官方 origin 下解析，不能继承页面以外的主机。
    const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => fakeBrowser([], [[
      visibleUpgradeLink("/item/software/D70050000064985"),
      visibleUpgradeLink("https://store-jp.nintendo.com/item/software/D70050000064985/"),
    ]]));
    const productUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
    const result = await batch.resolve([root(productUrl)], new AbortController().signal);

    expect(result.get(productUrl)).toEqual({ status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" });
  });

  it("returns safe relation statuses for missing, multiple, and invalid visible links", async () => {
    // 可见升级路径必须唯一且所有 href 合规；隐藏元素、零条、两条不同链接及一条非法链接均不能自动建立商品关系。
    const missingUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
    const multipleUrl = "https://store-jp.nintendo.com/item/software/D70010000106253/";
    const invalidUrl = "https://store-jp.nintendo.com/item/software/D70010000106254/";
    const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => fakeBrowser([], [
      [hiddenUpgradeLink("https://store-jp.nintendo.com/item/software/D70050000064985/")],
      [visibleUpgradeLink("/item/software/D70050000064985/"), visibleUpgradeLink("/item/software/D70050000064986/")],
      [visibleUpgradeLink("https://evil.example/item/software/D70050000064985/")],
    ]));
    const result = await batch.resolve([root(missingUrl), root(multipleUrl), root(invalidUrl)], new AbortController().signal);

    expect(result.get(missingUrl)).toEqual({ status: "blocked-or-missing" });
    expect(result.get(multipleUrl)).toEqual({ status: "multiple-matches" });
    expect(result.get(invalidUrl)).toEqual({ status: "invalid-official-url" });
  });

  it("closes the browser once when navigation throws and does not relaunch", async () => {
    // 非超时运行错误不得携带底层细节或触发重试；即使导航失败，也必须最终关闭本页、上下文及唯一浏览器。
    // 生产 close 契约始终返回 Promise；替身也必须异步，才能验证 closeSafely 处理的是远端关闭的拒绝而非错误夹具。
    const close = vi.fn(async () => undefined);
    const launchBrowser = vi.fn().mockResolvedValue(failingBrowser(new Error("do not expose runtime details"), close));
    const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser);

    await batch.resolve([root("https://store-jp.nintendo.com/item/software/D70010000106252/")], new AbortController().signal);

    expect(launchBrowser).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("maps a Playwright navigation TimeoutError without retrying", async () => {
    // Cloudflare/Playwright 的超时名称是可安全分类的控制信息；不返回异常正文，且单项最多尝试一次以保护每日配额。
    const timeout = Object.assign(new Error("navigation exceeded limit"), { name: "TimeoutError" });
    // 超时夹具同样保留异步关闭形状，避免同步 undefined 干扰本例只关心的 TimeoutError 分类。
    const launchBrowser = vi.fn().mockResolvedValue(failingBrowser(timeout, vi.fn(async () => undefined)));
    const result = await createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser)
      .resolve([root("https://store-jp.nintendo.com/item/software/D70010000106252/")], new AbortController().signal);

    expect(result.get("https://store-jp.nintendo.com/item/software/D70010000106252/")).toEqual({ status: "timeout" });
    expect(launchBrowser).toHaveBeenCalledTimes(1);
  });

  it("closes a context that resolves after timeout without opening a late page", async () => {
    // newContext 不能接受 AbortSignal；30 秒先向调用方返回 timeout，若远端随后才交付上下文，适配器只能立即清理，绝不能开始页面或导航。
    vi.useFakeTimers();
    try {
      const lateContext = deferred<ReturnType<typeof contextWithPage>>();
      const lateNewPage = vi.fn(async () => pageWithUpgradeLink("/item/software/D70050000064985/"));
      const lateContextClose = vi.fn(async () => undefined);
      const browserClose = vi.fn(async () => undefined);
      const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => ({
        newContext: () => lateContext.promise,
        close: browserClose,
      }));
      const productUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
      const resolution = batch.resolve([root(productUrl)], new AbortController().signal);

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(resolution).resolves.toEqual(new Map([[productUrl, { status: "timeout" }]]));

      lateContext.resolve({ newPage: lateNewPage, close: lateContextClose });
      await flushMicrotasks();

      expect(lateNewPage).not.toHaveBeenCalled();
      expect(lateContextClose).toHaveBeenCalledTimes(1);
      expect(browserClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not navigate a page that resolves after timeout while the next root runs", async () => {
    // 前项卡在 newPage 时尚无可执行页面，超时后的下一项可安全继续；迟到 page 必须只关闭且绝不 goto/提取，防止形成跨项并发业务操作。
    vi.useFakeTimers();
    try {
      const firstPage = deferred<ReturnType<typeof pageWithUpgradeLink>>();
      const firstNewPage = vi.fn(() => firstPage.promise);
      const firstContextClose = vi.fn(async () => undefined);
      const firstLateGoto = vi.fn(async () => undefined);
      const firstLateClose = vi.fn(async () => undefined);
      const secondGoto = vi.fn(async () => undefined);
      let contextCount = 0;
      const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => ({
        newContext: async () => {
          contextCount += 1;
          if (contextCount === 1) return { newPage: firstNewPage, close: firstContextClose };
          return contextWithPage(pageWithUpgradeLink("/item/software/D70050000064985/", secondGoto));
        },
        close: async () => undefined,
      }));
      const firstUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
      const secondUrl = "https://store-jp.nintendo.com/item/software/D70010000106253/";
      const resolution = batch.resolve([root(firstUrl), root(secondUrl)], new AbortController().signal);

      await flushMicrotasks();
      expect(firstNewPage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(resolution).resolves.toEqual(new Map([
        [firstUrl, { status: "timeout" }],
        [secondUrl, { status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" }],
      ]));
      expect(secondGoto).toHaveBeenCalledTimes(1);

      firstPage.resolve({
        goto: firstLateGoto,
        locator: () => ({ all: async () => [visibleUpgradeLink("/item/software/D70050000064985/")] }),
        close: firstLateClose,
      });
      await flushMicrotasks();

      expect(firstLateGoto).not.toHaveBeenCalled();
      expect(firstLateClose).toHaveBeenCalledTimes(1);
      expect(firstContextClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops remaining roots when a pending newPage context cannot close after timeout", async () => {
    // context 已交付就可能保有隔离状态；即使 newPage 永不返回，close 拒绝也不能让同一 browser 开启第二 context，剩余根必须安全降级。
    vi.useFakeTimers();
    try {
      const pendingPage = deferred<ReturnType<typeof pageWithUpgradeLink>>();
      const firstContextClose = vi.fn(async () => Promise.reject(new Error("context close detail")));
      const secondContext = vi.fn();
      let contextCount = 0;
      const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => ({
        newContext: async () => {
          contextCount += 1;
          if (contextCount === 1) return { newPage: () => pendingPage.promise, close: firstContextClose };
          secondContext();
          return contextWithPage(pageWithUpgradeLink("/item/software/D70050000064985/"));
        },
        close: async () => undefined,
      }));
      const firstUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
      const secondUrl = "https://store-jp.nintendo.com/item/software/D70010000106253/";
      const resolution = batch.resolve([root(firstUrl), root(secondUrl)], new AbortController().signal);

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(resolution).resolves.toEqual(new Map([
        [firstUrl, { status: "timeout" }],
        [secondUrl, { status: "browser-unavailable" }],
      ]));
      expect(firstContextClose).toHaveBeenCalledTimes(1);
      expect(secondContext).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a timed-out page close before starting the next root", async () => {
    // 已交付页面的 goto 可能仍在远端执行；timeout 后必须先确认 page → context 关闭，才可创建下一项 context，避免同一 browser 出现并发业务操作。
    vi.useFakeTimers();
    try {
      const firstGoto = deferred<void>();
      const firstClose = deferred<void>();
      const events: string[] = [];
      const firstLocator = vi.fn(() => ({ all: async () => [] }));
      const secondGoto = vi.fn(async () => undefined);
      let contextCount = 0;
      const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => ({
        newContext: async () => {
          contextCount += 1;
          if (contextCount === 1) {
            return {
              newPage: async () => ({
                goto: () => firstGoto.promise,
                locator: firstLocator,
                close: async () => { events.push("first-page-close-start"); await firstClose.promise; events.push("first-page-close-end"); },
              }),
              close: async () => { events.push("first-context-close"); },
            };
          }
          events.push("second-context");
          return contextWithPage(pageWithUpgradeLink("/item/software/D70050000064985/", secondGoto));
        },
        close: async () => { events.push("browser-close"); },
      }));
      const firstUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
      const secondUrl = "https://store-jp.nintendo.com/item/software/D70010000106253/";
      const resolution = batch.resolve([root(firstUrl), root(secondUrl)], new AbortController().signal);

      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events).toEqual(["first-page-close-start"]);
      expect(secondGoto).not.toHaveBeenCalled();

      firstClose.resolve();
      await flushMicrotasks();
      expect(events.indexOf("first-page-close-end")).toBeGreaterThan(events.indexOf("first-page-close-start"));
      expect(events.indexOf("first-context-close")).toBeGreaterThan(events.indexOf("first-page-close-end"));
      expect(events.indexOf("second-context")).toBeGreaterThan(events.indexOf("first-context-close"));

      await expect(resolution).resolves.toEqual(new Map([
        [firstUrl, { status: "timeout" }],
        [secondUrl, { status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" }],
      ]));
      firstGoto.resolve();
      await flushMicrotasks();

      expect(firstLocator).not.toHaveBeenCalled();
      expect(events.at(-1)).toBe("browser-close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a completed success while page cleanup lasts beyond the business deadline", async () => {
    // 30 秒只限制导航和关系提取；成功证据一旦得到就必须取消 deadline，慢 page close 只能延后串行下一项，不能把 success 改写为 timeout。
    vi.useFakeTimers();
    try {
      const pageClose = deferred<void>();
      const events: string[] = [];
      const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => ({
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => undefined,
            locator: () => ({ all: async () => [visibleUpgradeLink("/item/software/D70050000064985/")] }),
            close: async () => { events.push("page-close-start"); await pageClose.promise; events.push("page-close-end"); },
          }),
          close: async () => { events.push("context-close"); },
        }),
        close: async () => { events.push("browser-close"); },
      }));
      const productUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
      let settled = false;
      const resolution = batch.resolve([root(productUrl)], new AbortController().signal).then((result) => { settled = true; return result; });

      await flushMicrotasks();
      expect(events).toEqual(["page-close-start"]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);
      expect(events).toEqual(["page-close-start"]);

      pageClose.resolve();
      await expect(resolution).resolves.toEqual(new Map([[productUrl, {
        status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/",
      }]]));
      expect(events).toEqual(["page-close-start", "page-close-end", "context-close", "browser-close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replace a successful business result when resource cleanup fails", async () => {
    // close 失败可能来自已断开的远端会话；业务结论已经由受控 DOM 证据得到，不能因清理异常改写或泄漏错误内容。
    const batch = createJapaneseUpgradeBrowserBatch({} as Fetcher, async () => ({
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => undefined,
          locator: () => ({ all: async () => [visibleUpgradeLink("/item/software/D70050000064985/")] }),
          close: async () => Promise.reject(new Error("page cleanup detail")),
        }),
        close: async () => Promise.reject(new Error("context cleanup detail")),
      }),
      close: async () => Promise.reject(new Error("browser cleanup detail")),
    }));
    const productUrl = "https://store-jp.nintendo.com/item/software/D70010000106252/";
    const result = await batch.resolve([root(productUrl)], new AbortController().signal);

    expect(result.get(productUrl)).toEqual({ status: "success", upgradeUrl: "https://store-jp.nintendo.com/item/software/D70050000064985/" });
  });

  it("rejects four roots before launching a browser", async () => {
    // 三项是已批准的单请求深度核验上限；超过上限必须完整拒绝，而非静默只处理前三项或创建浏览器后失败。
    const launchBrowser = vi.fn();
    const roots = Array.from({ length: 4 }, (_, index) => root(`https://store-jp.nintendo.com/item/software/D7001000010625${index}/`));

    await expect(createJapaneseUpgradeBrowserBatch({} as Fetcher, launchBrowser).resolve(roots, new AbortController().signal))
      .rejects.toThrow("一次最多核验 3 个日区升级包");
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

/** 构造已由上游身份检索得到的最小根候选；各测试只覆盖 Browser 层的 URL 和生命周期边界。 */
function root(productUrl: string): JapaneseUpgradeRootCandidate {
  return {
    productUrl,
    canonicalTitle: "Overcooked® 2 - オーバークック２ Nintendo Switch 2 Edition",
    publisher: "Team17",
  };
}

/** 构造可见的升级路径元素；文本和 href 分开模拟以验证 DOM 文本过滤不能被 URL 本身绕过。 */
function visibleUpgradeLink(href: string) {
  return { isVisible: async () => true, innerText: async () => "アップグレードパス", getAttribute: async () => href };
}

/** 隐藏链接即使 href 合规也不属于管理员可见的页面证据，不能进入自动关系判断。 */
function hiddenUpgradeLink(href: string) {
  return { isVisible: async () => false, innerText: async () => "アップグレードパス", getAttribute: async () => href };
}

/**
 * 以最窄 Playwright 形状记录资源事件，不模拟页面正文或任何会话状态。
 * 每个 context 只暴露本例 links，借此验证调用方的串行新建与 finally 关闭，不把替身变成真实浏览器契约。
 */
function fakeBrowser(events: string[], linksByContext: Array<Array<ReturnType<typeof visibleUpgradeLink> | ReturnType<typeof hiddenUpgradeLink>>>) {
  let index = 0;
  events.push("launch");
  return {
    async newContext() {
      index += 1;
      const contextIndex = index;
      events.push(`context:${contextIndex}`);
      return {
        async newPage() {
          events.push(`page:${contextIndex}`);
          return {
            goto: async (url: string, options: { timeout: number }) => { events.push(`goto:${contextIndex}:${url}:${options.timeout}`); },
            locator: () => ({ all: async () => linksByContext[contextIndex - 1] }),
            close: async () => { events.push(`page-close:${contextIndex}`); },
          };
        },
        close: async () => { events.push(`context-close:${contextIndex}`); },
      };
    },
    close: async () => { events.push("browser-close"); },
  };
}

/** 构造仅在导航阶段抛错的浏览器替身，确保错误分类和请求级关闭不依赖真实 Playwright 错误对象。 */
function failingBrowser(error: Error, close: () => Promise<void>) {
  return {
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => Promise.reject(error),
        locator: () => ({ all: async () => [] }),
        // Page 关闭是异步远端资源释放；用异步 mock 保持与 BrowserPageLike 契约一致。
        close: vi.fn(async () => undefined),
      }),
      // Context 也必须异步关闭，确保测试只检验业务失败分类而不会由夹具制造 TypeError。
      close: vi.fn(async () => undefined),
    }),
    close,
  };
}

/**
 * 构造可控延迟 Promise，专门模拟 Browser Run 在 30 秒后才交付 context/page 的竞态。
 * 测试通过它证明迟到资源只会被关闭，不需要真实网络、浏览器进程或会话内容。
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** 生成带唯一合规升级链接的最窄页面；可替换 goto 以记录下一项与迟到页面是否发生业务导航。 */
function pageWithUpgradeLink(href: string, goto: () => Promise<void> = async () => undefined) {
  return {
    goto,
    locator: () => ({ all: async () => [visibleUpgradeLink(href)] }),
    close: async () => undefined,
  };
}

/** 生成最窄 context，避免延迟生命周期测试引入页面正文、Cookie 或真实 Playwright 行为。 */
function contextWithPage(page: ReturnType<typeof pageWithUpgradeLink>) {
  return { newPage: async () => page, close: async () => undefined };
}

/**
 * 刷新有限轮微任务，让窄替身中的 context → page → goto/locator 续体及安全关闭调用完成，而不依赖真实时钟。
 * 固定上限只服务于内存替身的确定性调度，不模拟 Browser Run 的时间；真正的 30 秒边界始终由 fake timer 显式推进。
 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
