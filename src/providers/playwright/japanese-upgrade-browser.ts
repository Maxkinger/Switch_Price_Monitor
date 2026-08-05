import type { JapaneseUpgradeRootCandidate } from "../official-japanese-upgrade-root";
import type { ProxySettings } from "../../shared/proxy-settings";
import {
  type BrowserContextLike,
  type BrowserLauncher,
  type BrowserLike,
  type BrowserPageLike,
} from "./browser-launcher";
import { isBrowserProxyTransportError } from "./browser-errors";

// 兼容现有关系适配器测试的窄类型出口；类型仍由 launcher 统一定义，运行时不会新增浏览器控制面。
export type { BrowserContextLike, BrowserLauncher, BrowserLike, BrowserPageLike } from "./browser-launcher";

/** 单项 Browser Run 关系核验只返回已脱敏的业务分类，绝不向上层暴露页面正文、会话标识或底层异常。 */
export type JapaneseUpgradeBrowserResult =
  | { status: "success"; upgradeUrl: string }
  | { status: "browser-unavailable" | "timeout" | "blocked-or-missing" | "multiple-matches" | "invalid-official-url" };

/** 请求级批处理契约：每次调用独占一次浏览器，并按输入顺序返回每个根 URL 的独立安全结论。 */
export interface JapaneseUpgradeBrowserBatch {
  resolve(roots: JapaneseUpgradeRootCandidate[], signal: AbortSignal): Promise<Map<string, JapaneseUpgradeBrowserResult>>;
}

/** 代理设置读取器只在一次批处理开始时调用一次；后续 PATCH 不得改变已启动浏览器的出口。 */
export interface JapaneseUpgradeBrowserBatchOptions {
  readProxySettings?: () => Promise<ProxySettings>;
}

/** 超过已批准的三项深度核验上限时使用的受控错误；路由层可据此返回明确的 422，而不会部分处理输入。 */
export class JapaneseUpgradeBatchLimitError extends Error {}

/** 单项导航加页面关系提取的统一上限；没有重试，避免 Browser Run 额度或排队限制被单请求放大。 */
const itemTimeoutMs = 30_000;

/**
 * 创建日区升级路径的请求级 Browser Run 适配器。
 * 本地启动器只交付窄 BrowserLike；关系适配器不接触 Playwright 调试 API、数据库、Telegram 或浏览器配置，
 * 从而让后续代理配置只能在启动器边界映射为 Chromium 选项，不能进入业务提取逻辑。
 */
export function createJapaneseUpgradeBrowserBatch(launcher: BrowserLauncher, options: JapaneseUpgradeBrowserBatchOptions = {}): JapaneseUpgradeBrowserBatch {
  return {
    async resolve(roots, signal) {
      if (roots.length > 3) {
        throw new JapaneseUpgradeBatchLimitError("一次最多核验 3 个日区升级包，请分批处理。");
      }
      if (roots.length === 0) return new Map();

      const results = new Map<string, JapaneseUpgradeBrowserResult>();
      // 在启动前筛出所有不满足精确官方根路径的输入，阻止此低层公共适配器成为任意站点导航或 SSRF 边界。
      const validRoots = roots.filter((root) => {
        if (isJapaneseRootUrl(root.productUrl)) return true;
        results.set(root.productUrl, { status: "browser-unavailable" });
        return false;
      });
      if (validRoots.length === 0) return results;

      // 代理快照在浏览器创建前只读取一次；读取失败按关闭代理处理，避免设置暂时不可用时阻塞既有直连能力。
      const proxySettings = await options.readProxySettings?.().catch(() => undefined);
      let proxyMode = proxySettings?.enabled === true;
      let hasFallenBack = false;
      let browser: BrowserLike | undefined;
      try {
        try {
          browser = await launcher.launch(proxyMode ? { proxy: proxySettings } : undefined);
        } catch (error) {
          if (!proxyMode || !isBrowserProxyTransportError(error)) {
            for (const root of validRoots) results.set(root.productUrl, { status: "browser-unavailable" });
            return results;
          }
          // 代理浏览器连启动都失败时仍只允许一次直连；代理实例未交付，不存在需要关闭的页面树。
          proxyMode = false;
          hasFallenBack = true;
          browser = await launchDirectOrMarkUnavailable(launcher, validRoots, results);
          if (browser === undefined) return results;
        }
        // 串行处理可避免同一请求内并发上下文争抢 Browser Run 配额；已交付页面的关闭屏障未确认前绝不进入下一个根。
        for (let index = 0; index < validRoots.length; index += 1) {
          const root = validRoots[index];
          const resolved = await resolveOne(browser, root, signal);

          if (proxyMode && !hasFallenBack && resolved.proxyFailure && !signal.aborted) {
            // 当前代理浏览器必须先完整关闭；关闭拒绝时不启动直连，剩余项全部安全降级，防止两个浏览器并存。
            const closed = await closeSafely(browser);
            browser = undefined;
            proxyMode = false;
            hasFallenBack = true;
            if (!closed) {
              markRemainingUnavailable(validRoots, results, index);
              break;
            }
            browser = await launchDirectOrMarkUnavailable(launcher, validRoots.slice(index), results);
            if (browser === undefined) break;
            index -= 1;
            continue;
          }

          results.set(root.productUrl, resolved.result);
          if (!resolved.canContinue) {
            // 关闭拒绝时不覆盖本项业务结论，但后续根不能复用可能仍忙碌的 browser，必须全部安全降级。
            for (const remaining of validRoots.slice(index + 1)) results.set(remaining.productUrl, { status: "browser-unavailable" });
            break;
          }
        }
      } catch {
        // 启动失败或未预料的批处理错误均只填充未完成项；不得把错误正文、堆栈或远端会话数据写入输出。
        for (const root of validRoots) {
          if (!results.has(root.productUrl)) results.set(root.productUrl, { status: "browser-unavailable" });
        }
      } finally {
        // 浏览器关闭是尽力而为的生命周期清理；远端关闭失败不能覆盖任何已得出的业务分类。
        await closeSafely(browser);
      }
      return results;
    },
  };
}

/**
 * 对一个已验证根执行独立上下文核验。整个导航和 DOM 关系读取共享 30 秒失败边界；任一阶段没有重试，
 * 因为二次访问可能产生新的排队或页面状态，既浪费免费额度也不能增加可审计的官方证据。
 */
async function resolveOne(
  browser: BrowserLike,
  root: JapaneseUpgradeRootCandidate,
  signal: AbortSignal,
): Promise<ResolvedOne> {
  if (signal.aborted) return { result: { status: "browser-unavailable" }, proxyFailure: false, canContinue: true };
  const lifecycle = new ItemLifecycle();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const operation = resolveOneOperation(browser, root, lifecycle);
  const deadlineOrAbort = new Promise<OperationOutcome>((resolve) => {
    timeoutId = setTimeout(() => {
      // 先把生命周期切到取消态并立即关闭已知资源，再返回 timeout；迟到资源会在交付瞬间走同一关闭路径。
      lifecycle.cancel();
      resolve({ result: { status: "timeout" }, proxyFailure: false });
    }, itemTimeoutMs);
    const abort = () => {
      // AbortSignal 不能直接传给 Playwright，因此关闭已知 page/context 是停止已发出浏览器工作的唯一受控动作。
      lifecycle.cancel();
      resolve({ result: { status: "browser-unavailable" }, proxyFailure: false });
    };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  let outcome: OperationOutcome;
  try {
    // race 只限制导航和 DOM 关系提取；它绝不包含 close，慢清理不能把已确认的 success 改写为 timeout。
    outcome = await Promise.race([operation, deadlineOrAbort]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    removeAbortListener?.();
  }
  // 业务结果决定后 deadline 已取消；page → context 清理只决定是否可继续同一 browser，不得改变本项状态。
  return { result: outcome.result, proxyFailure: outcome.proxyFailure, canContinue: await lifecycle.finishAfterBusiness() };
}

/** 单项业务结果与继续资格分离：关闭失败只能阻断后续根，不能覆盖本项已有的官方关系结论。 */
interface ResolvedOne {
  result: JapaneseUpgradeBrowserResult;
  proxyFailure: boolean;
  canContinue: boolean;
}

/** 单项操作只把可回退的代理传输错误与普通业务失败分开；其他异常仍保持既有脱敏状态。 */
interface OperationOutcome {
  result: JapaneseUpgradeBrowserResult;
  proxyFailure: boolean;
}

/**
 * 顺序执行单项所有浏览器动作，并在每个 await 后检查取消态。
 * 若 timeout 已先返回，迟到 context/page 只会被生命周期对象关闭；它们绝不会继续创建页面、导航或读取 DOM，
 * 因而下一项开始时不会与前项尚存的业务操作并发。关闭不在此 Promise 内，调用方会先清除业务 deadline 再建立 page → context 屏障。
 */
async function resolveOneOperation(
  browser: BrowserLike,
  root: JapaneseUpgradeRootCandidate,
  lifecycle: ItemLifecycle,
): Promise<OperationOutcome> {
  try {
    const context = await browser.newContext();
    if (!lifecycle.adoptContext(context)) return { result: { status: "browser-unavailable" }, proxyFailure: false };

    const page = await context.newPage();
    if (!lifecycle.adoptPage(page)) return { result: { status: "browser-unavailable" }, proxyFailure: false };

    await page.goto(root.productUrl, { waitUntil: "domcontentloaded", timeout: itemTimeoutMs });
    lifecycle.assertActive();
    return { result: await extractUpgradeRelation(page, lifecycle), proxyFailure: false };
  } catch (error) {
    // TimeoutError 是 Playwright 可识别的控制类型；本地取消标记和其他错误都不泄露详情，只安全降级。
    if (isBrowserProxyTransportError(error)) return { result: { status: "browser-unavailable" }, proxyFailure: true };
    return {
      result: error instanceof ItemTimeoutError || (error instanceof Error && error.name === "TimeoutError")
        ? { status: "timeout" }
        : { status: "browser-unavailable" },
      proxyFailure: false,
    };
  }
}

/** 直连启动失败时不泄露异常正文，并把当前及剩余根标为不可用，避免隐式第三次尝试。 */
async function launchDirectOrMarkUnavailable(
  launcher: BrowserLauncher,
  roots: JapaneseUpgradeRootCandidate[],
  results: Map<string, JapaneseUpgradeBrowserResult>,
): Promise<BrowserLike | undefined> {
  try {
    return await launcher.launch();
  } catch {
    for (const root of roots) results.set(root.productUrl, { status: "browser-unavailable" });
    return undefined;
  }
}

/** 回退资源关闭失败时，当前项与未开始项都不能复用未知状态的浏览器。 */
function markRemainingUnavailable(
  roots: JapaneseUpgradeRootCandidate[],
  results: Map<string, JapaneseUpgradeBrowserResult>,
  startIndex: number,
): void {
  for (const root of roots.slice(startIndex)) results.set(root.productUrl, { status: "browser-unavailable" });
}

/**
 * 从已加载页面提取唯一、可见且文案含“アップグレードパス”的官方链接。
 * 先检查可见性和实际文本，避免隐藏模板或仅靠 CSS/URL 伪造证据；归一化后去重以容纳同一链接的桌面/移动重复渲染。
 */
async function extractUpgradeRelation(page: BrowserPageLike, lifecycle: ItemLifecycle): Promise<JapaneseUpgradeBrowserResult> {
  const urls = new Set<string>();
  const links = await page.locator('a:has-text("アップグレードパス")').all();
  lifecycle.assertActive();
  for (const link of links) {
    const visible = await link.isVisible();
    lifecycle.assertActive();
    if (!visible) continue;
    const text = await link.innerText();
    lifecycle.assertActive();
    if (!text.includes("アップグレードパス")) continue;
    const href = await link.getAttribute("href");
    lifecycle.assertActive();
    const normalized = normalizeJapaneseUpgradeUrl(href);
    // 一条可见升级文案的链接若非严格官方 URL，不能被忽略后继续自动关联，必须交由上层人工路径复核。
    if (normalized === null) return { status: "invalid-official-url" };
    urls.add(normalized);
  }
  if (urls.size === 0) return { status: "blocked-or-missing" };
  if (urls.size > 1) return { status: "multiple-matches" };
  return { status: "success", upgradeUrl: [...urls][0] };
}

/**
 * 仅接受同站相对路径或精确的日区商城 HTTPS 下载软件链接，并统一为带尾斜杠的绝对 URL。
 * 严格拒绝非 HTTPS、其他主机、端口、凭据、查询、片段和非 D 数字软件路径，防止 DOM href 将解析器导向外站或带状态参数的页面。
 */
export function normalizeJapaneseUpgradeUrl(value: string | null): string | null {
  if (value === null || /\s/u.test(value)) return null;
  try {
    const url = new URL(value, "https://store-jp.nintendo.com");
    const match = /^\/item\/software\/(D[0-9]+)\/?$/.exec(url.pathname);
    return url.protocol === "https:"
      && url.hostname === "store-jp.nintendo.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && match !== null
      ? `https://store-jp.nintendo.com/item/software/${match[1]}/`
      : null;
  } catch {
    return null;
  }
}

/**
 * 根 URL 只允许精确、无附加部分的日区数字下载软件路径；解析后的字段与原始字符串都必须匹配受控 canonical 形式，
 * 因而末尾换行、空白、编码变体和 URL 解析器会宽容处理的附加字符也会失败。该校验在所有 browser/context/page 创建前运行，
 * 使即使未来错误调用本公开工厂，也无法通过产品 URL 导航到任意协议、主机、端口或含状态参数的地址。
 */
function isJapaneseRootUrl(value: string): boolean {
  if (/\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    const match = /^\/item\/software\/(D[0-9]+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "store-jp.nintendo.com" || url.port !== ""
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || match === null) return false;
    const canonicalWithoutSlash = `https://store-jp.nintendo.com/item/software/${match[1]}`;
    return value === canonicalWithoutSlash || value === `${canonicalWithoutSlash}/`;
  } catch {
    return false;
  }
}

/** 统一的内部超时标记不含上游消息，用于把导航和提取超过 30 秒的情形安全映射为业务状态。 */
class ItemTimeoutError extends Error {}

/**
 * 单项资源的可取消所有权。Browser Run 的 newContext/newPage 不接受 AbortSignal，故 timeout 后不能仅靠 Promise.race 忽略它们：
 * 已交付 page 的关闭必须形成 page → context 屏障，迟到资源在 adopt 时立即关闭；每个业务 await 后由 assertActive 阻断后续导航和 DOM 读取。
 */
class ItemLifecycle {
  private cancelled = false;
  private context: BrowserContextLike | undefined;
  private page: BrowserPageLike | undefined;
  private pageClose: Promise<boolean> | undefined;
  private contextClose: Promise<boolean> | undefined;
  private cleanupBarrier: Promise<boolean> | undefined;

  /** 接纳刚交付的 context；超时后只关闭它，不允许再创建 page，因此永不 resolve 的 newContext 不会拖过业务 deadline。 */
  adoptContext(context: BrowserContextLike): boolean {
    this.context = context;
    if (!this.cancelled) return true;
    void this.closeContext();
    return false;
  }

  /**
   * 接纳刚交付的 page；超时后它绝不允许 goto 或 locator。
   * 若先前仅因 context 已交付而完成了“无 page”屏障，迟到 page 仍须独立且仅一次 close，不能被缓存的屏障误跳过。
   */
  adoptPage(page: BrowserPageLike): boolean {
    this.page = page;
    if (!this.cancelled) return true;
    if (this.cleanupBarrier === undefined) void this.startCleanupBarrier();
    else void this.closePage();
    return false;
  }

  /** 在每个异步业务边界之后调用，确保 timeout/abort 不能让旧项继续导航或提取关系。 */
  assertActive(): void {
    if (this.cancelled) throw new ItemTimeoutError();
  }

  /**
   * 进入取消态。只要 context 已交付（无论 page 是否仍在等待）就必须马上建立顺序关闭屏障并由主循环等待，
   * 因为 context 仍可能保有隔离状态；只有 context 尚未交付时才允许立即返回 timeout，迟到资源仍会在 adopt 时关闭。
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.context !== undefined) void this.startCleanupBarrier();
  }

  /**
   * 在业务结果确定且 deadline 清除后等待所需清理。返回 false 表示 close 拒绝，调用方必须停止后续根，
   * 但绝不能改写已经确认的 success、timeout 或其他安全分类。
   */
  async finishAfterBusiness(): Promise<boolean> {
    if (this.cancelled && this.cleanupBarrier === undefined) return true;
    return await this.startCleanupBarrier();
  }

  /** 只创建一次 page → context 顺序关闭屏障；请求级 browser.close 只能在已知资源链完成后运行。 */
  private startCleanupBarrier(): Promise<boolean> {
    if (this.cleanupBarrier !== undefined) return this.cleanupBarrier;
    this.cleanupBarrier = (async () => {
      const pageClosed = await this.closePage();
      const contextClosed = await this.closeContext();
      return pageClosed && contextClosed;
    })();
    return this.cleanupBarrier;
  }

  /** 每类资源只调用一次 close，避免 timeout、迟到交付和正常收尾重复发出关闭请求。 */
  private closePage(): Promise<boolean> {
    if (this.page === undefined) return Promise.resolve(true);
    if (this.pageClose !== undefined) return this.pageClose;
    this.pageClose = closeSafely(this.page);
    return this.pageClose;
  }

  /** context 与 page 一样只尽力关闭一次；boolean 仅用于阻断后续项，不会被记录或返回给外部。 */
  private closeContext(): Promise<boolean> {
    if (this.context === undefined) return Promise.resolve(true);
    if (this.contextClose !== undefined) return this.contextClose;
    this.contextClose = closeSafely(this.context);
    return this.contextClose;
  }
}

/**
 * 关闭本地 Chromium 资源时吞掉异常正文并只返回是否已确认完成；清理不是本项业务结果的证据来源。
 * 参数只要求 close 能力，以复用同一规则处理 page、context 和 browser，且不会记录任何会话或异常细节。
 */
async function closeSafely(resource: { close(): Promise<void> } | undefined): Promise<boolean> {
  if (resource === undefined) return true;
  try {
    await resource.close();
    return true;
  } catch {
    return false;
  }
}
