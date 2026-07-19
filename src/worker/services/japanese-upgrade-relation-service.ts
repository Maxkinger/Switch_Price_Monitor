import type { OfficialProductCandidate, RegionalProductMatchSource } from "../../shared/domain";
import {
  JapaneseUpgradeBatchLimitError,
  normalizeJapaneseUpgradeUrl,
  type JapaneseUpgradeBrowserBatch,
  type JapaneseUpgradeBrowserResult,
} from "../providers/japanese-upgrade-browser";
import type { JapaneseUpgradeRootCandidate, JapaneseUpgradeRootSearch } from "../providers/official-japanese-upgrade-root";
import type { NintendoOfficialPriceQuote, NintendoOfficialPriceQuoteResolver } from "../providers/official-nintendo-price-api";
import { officialCandidateKey } from "./official-product-discovery-service";

/** 自动发现只在三份当前官方证据完整时返回候选；无法证明时使用固定文案引导管理员走受控人工链接流程。 */
export type JapaneseUpgradeDiscoveryResult =
  | { status: "automatic"; candidate: OfficialProductCandidate }
  | { status: "needs-manual-link"; message: "日区自动核验暂不可用，请重新核验或粘贴官方链接。" };

/** 保存前复核的一项升级包映射；来源枚举来自共享领域模型，服务仍会拒绝不属于本关系流程的来源。 */
export interface JapaneseUpgradeConfirmationItem {
  anchor: OfficialProductCandidate;
  candidate: OfficialProductCandidate;
  matchSource: RegionalProductMatchSource;
}

/** 最终复核只能重新签发 automatic 或 manual 结论；任何证据缺失均显式拒绝而非返回外部错误。 */
export type JapaneseUpgradeConfirmationResult =
  | { status: "verified-automatic" | "verified-manual"; candidate: OfficialProductCandidate }
  | { status: "rejected" };

/** 将根检索、Browser Run 与官方报价组合为三个窄入口；接口不暴露缓存、日志、D1 或重试能力。 */
export interface JapaneseUpgradeRelationService {
  discover(anchors: OfficialProductCandidate[]): Promise<Map<string, JapaneseUpgradeDiscoveryResult>>;
  resolveManual(anchor: OfficialProductCandidate, productUrl: string): Promise<OfficialProductCandidate | null>;
  verifyForConfirmation(items: JapaneseUpgradeConfirmationItem[]): Promise<Map<string, JapaneseUpgradeConfirmationResult>>;
}

/** 已批准的 Browser Run 深度核验上限；服务层须在任何官网或浏览器调用前强制执行，防止绕过低层适配器的配额保护。 */
const batchLimit = 3;

/** 重复结果键无法由 Map 保留为两项独立结论；使用路由已识别的受控错误类型整体拒绝，避免后项覆盖前项。 */
const duplicateInputMessage = "日区升级包输入包含重复项，请移除重复项后重试。";

/** 固定 UI 文案不携带网络、浏览器或价格 API 的异常内容，避免外部响应泄漏到管理员界面。 */
const manualMessage = "日区自动核验暂不可用，请重新核验或粘贴官方链接。" as const;

/** 日区商城 canonical URL 中 D 后的纯数字与官方价格 API 的 title ID 是同一受控商品身份。 */
const japaneseUpgradeUrl = /^https:\/\/store-jp\.nintendo\.com\/item\/software\/D(\d+)\/$/;

/** 已通过本地输入校验、可进入外部复核的确认计划；在此处收窄 URL、价格 ID 与来源，避免后续异步步骤重新接受不安全字段。 */
interface ConfirmationPlan {
  item: JapaneseUpgradeConfirmationItem & { matchSource: "automatic" | "manual_link" };
  key: string;
  canonicalUrl: string;
  officialPriceId: string;
}

/**
 * 创建无状态日区升级包关系服务。所有依赖都由调用方注入，生产路径不会自行访问网络；
 * 每个入口仅创建内部 AbortController 信号，使外部调用可被 Worker 生命周期统一约束而不扩展公共 API。
 */
export function createJapaneseUpgradeRelationService(
  roots: JapaneseUpgradeRootSearch,
  browser: JapaneseUpgradeBrowserBatch,
  prices: NintendoOfficialPriceQuoteResolver,
): JapaneseUpgradeRelationService {
  return {
    async discover(anchors) {
      assertBatchLimit(anchors.length);
      assertNoDuplicateKeys(anchors, officialCandidateKey);
      if (anchors.length === 0) return new Map();

      const controller = new AbortController();
      const rootsByAnchor = new Map<string, JapaneseUpgradeRootCandidate | null>();
      await Promise.all(anchors.map(async (anchor) => {
        const key = officialCandidateKey(anchor);
        if (!isUpgradeAnchor(anchor)) {
          rootsByAnchor.set(key, null);
          return;
        }
        try {
          // 根检索本身已执行跨语言身份和唯一性约束；异常只代表本项缺少证据，不能影响同批其他锚点。
          rootsByAnchor.set(key, await roots.search(anchor, controller.signal));
        } catch {
          rootsByAnchor.set(key, null);
        }
      }));

      const uniqueRoots = uniqueUsableRoots(rootsByAnchor.values());
      let browserResults: Map<string, JapaneseUpgradeBrowserResult> | null = null;
      if (uniqueRoots.length > 0) {
        try {
          // 本入口对去重后的根只启动一次批处理，确保同一请求不会为共享根重复消耗 Browser Run 配额。
          browserResults = await browser.resolve(uniqueRoots, controller.signal);
        } catch {
          // 批处理异常没有可供人工回退的单项状态；发现阶段统一安全降级，绝不回传异常正文。
          browserResults = null;
        }
      }

      const results = new Map<string, JapaneseUpgradeDiscoveryResult>();
      for (const anchor of anchors) {
        const key = officialCandidateKey(anchor);
        const root = rootsByAnchor.get(key) ?? null;
        const relation = root === null || browserResults === null ? null : browserResults.get(root.productUrl);
        if (!isBrowserSuccess(relation)) {
          results.set(key, needsManualLink());
          continue;
        }
        const canonicalUrl = canonicalJapaneseUpgradeUrl(relation.upgradeUrl);
        const officialPriceId = canonicalUrl === null ? null : priceIdFromCanonicalUrl(canonicalUrl);
        if (canonicalUrl === null || officialPriceId === null) {
          results.set(key, needsManualLink());
          continue;
        }
        try {
          const quote = await prices.resolve("JP", "JPY", officialPriceId, controller.signal);
          const candidate = root === null ? null : candidateFromEvidence(root, canonicalUrl, quote);
          results.set(key, candidate === null ? needsManualLink() : { status: "automatic", candidate });
        } catch {
          results.set(key, needsManualLink());
        }
      }
      return results;
    },

    async resolveManual(anchor, productUrl) {
      // 人工链接也必须由已确认的升级包锚点触发，避免将本服务变成任意日区商品的价格或身份查询器。
      if (!isUpgradeAnchor(anchor)) return null;
      const canonicalUrl = canonicalJapaneseUpgradeUrl(productUrl);
      const officialPriceId = canonicalUrl === null ? null : priceIdFromCanonicalUrl(canonicalUrl);
      if (canonicalUrl === null || officialPriceId === null) return null;

      const controller = new AbortController();
      let root: JapaneseUpgradeRootCandidate | null;
      try {
        // 此处故意不调用 Browser Run：管理员的链接只形成待复核候选，最终保存前仍由 verifyForConfirmation 重新检查关系。
        root = await roots.search(anchor, controller.signal);
      } catch {
        return null;
      }
      if (!isUsableRoot(root)) return null;

      try {
        const quote = await prices.resolve("JP", "JPY", officialPriceId, controller.signal);
        return candidateFromEvidence(root, canonicalUrl, quote);
      } catch {
        return null;
      }
    },

    async verifyForConfirmation(items) {
      assertBatchLimit(items.length);
      assertNoDuplicateKeys(items, japaneseUpgradeConfirmationKey);
      if (items.length === 0) return new Map();

      const results = new Map<string, JapaneseUpgradeConfirmationResult>();
      const controller = new AbortController();
      const plans: ConfirmationPlan[] = items.flatMap((item) => {
        const key = japaneseUpgradeConfirmationKey(item);
        const canonicalUrl = canonicalJapaneseUpgradeUrl(item.candidate.productUrl);
        const officialPriceId = canonicalUrl === null ? null : priceIdFromCanonicalUrl(canonicalUrl);
        if (!isUpgradeAnchor(item.anchor)
          || !isConfirmationSource(item.matchSource)
          || !hasBasicJapaneseUpgradeCandidateShape(item.candidate, canonicalUrl)
          || canonicalUrl === null
          || officialPriceId === null) {
          // 在外部调用前先拒绝篡改的类型、来源、地区、货币或 URL，防止无效输入占用官网和浏览器资源。
          results.set(key, { status: "rejected" });
          return [];
        }
        // 经过来源守卫后，计划类型不再允许 manual_selection 穿过后续浏览器和价格复核。
        const verifiedItem: ConfirmationPlan["item"] = { ...item, matchSource: item.matchSource };
        return [{ item: verifiedItem, key, canonicalUrl, officialPriceId }];
      });

      const rootsByKey = new Map<string, JapaneseUpgradeRootCandidate | null>();
      await Promise.all(plans.map(async (plan) => {
        try {
          rootsByKey.set(plan.key, await roots.search(plan.item.anchor, controller.signal));
        } catch {
          // 单项根检索异常只拒绝该项；不能用另一项根或历史结果补偿，防止跨商品关系串联。
          rootsByKey.set(plan.key, null);
        }
      }));

      const uniqueRoots = uniqueUsableRoots(rootsByKey.values());
      let browserResults: Map<string, JapaneseUpgradeBrowserResult> | null = new Map();
      if (uniqueRoots.length > 0) {
        try {
          // 所有待确认项共享一次根收集和一次 Browser 批处理；同根项从同一受控关系结果读取，绝不二次启动浏览器。
          browserResults = await browser.resolve(uniqueRoots, controller.signal);
        } catch {
          // Browser 调用抛错不是已分类的安全失败状态，不能允许 manual_link 兜底；所有仍待决项统一拒绝。
          browserResults = null;
        }
      }

      for (const plan of plans) {
        if (results.has(plan.key)) continue;
        const root = rootsByKey.get(plan.key) ?? null;
        if (!isUsableRoot(root) || browserResults === null || !candidateMatchesRootIdentity(plan.item.candidate, root, plan.canonicalUrl)) {
          results.set(plan.key, { status: "rejected" });
          continue;
        }
        const relation = browserResults.get(root.productUrl);
        if (!relationAllowsSource(relation, plan.item.matchSource, plan.canonicalUrl)) {
          results.set(plan.key, { status: "rejected" });
          continue;
        }
        try {
          const quote = await prices.resolve("JP", "JPY", plan.officialPriceId, controller.signal);
          const candidate = candidateFromEvidence(root, plan.canonicalUrl, quote);
          results.set(plan.key, candidate === null
            ? { status: "rejected" }
            : { status: plan.item.matchSource === "automatic" ? "verified-automatic" : "verified-manual", candidate });
        } catch {
          // 报价异常同样没有可审计的商品价格证据；返回受控拒绝而非外部消息，供路由原子中止保存。
          results.set(plan.key, { status: "rejected" });
        }
      }
      return results;
    },
  };
}

/** 确认键包含锚点、候选 URL 与来源，防止同一默认区商品的自动与人工决定在批次结果中互相覆盖。 */
export function japaneseUpgradeConfirmationKey(item: JapaneseUpgradeConfirmationItem): string {
  return `${officialCandidateKey(item.anchor)}|${item.candidate.productUrl}|${item.matchSource}`;
}

/** 超限在所有外部工作前同步抛出 Browser 适配器同一受控错误类型，保证路由可统一映射为安全 422。 */
function assertBatchLimit(length: number): void {
  if (length > batchLimit) throw new JapaneseUpgradeBatchLimitError("一次最多核验 3 个日区升级包，请分批处理。");
}

/**
 * 在创建任何 AbortController、官网搜索、Browser Run 或价格请求前拒绝重复业务键。
 * 这些键正是两个公开入口返回 Map 的键；若允许重复，后项会覆盖前项并使管理员无法知道哪一项真正被复核。
 */
function assertNoDuplicateKeys<T>(items: T[], readKey: (item: T) => string): void {
  const keys = new Set<string>();
  for (const item of items) {
    const key = readKey(item);
    if (keys.has(key)) throw new JapaneseUpgradeBatchLimitError(duplicateInputMessage);
    keys.add(key);
  }
}

/** 只有已确认的升级包类型才有资格请求日区根，普通本体、DLC 或空白类型不能触发跨语言自动关联。 */
function isUpgradeAnchor(anchor: OfficialProductCandidate): boolean {
  return anchor.productType === "upgrade-pack";
}

/** 将输入严格限制为规范化函数接受且原始字符串完全相同的形式，拒绝尾斜杠省略、查询或任意 URL 宽松改写。 */
function canonicalJapaneseUpgradeUrl(value: string): string | null {
  const normalized = normalizeJapaneseUpgradeUrl(value);
  return normalized !== null && normalized === value ? normalized : null;
}

/** 只有完整 canonical URL 才能提取价格 ID，避免把 URL 的其它数字、查询参数或不同商品路径传给官方价格 API。 */
function priceIdFromCanonicalUrl(productUrl: string): string | null {
  return japaneseUpgradeUrl.exec(productUrl)?.[1] ?? null;
}

/** 根候选来自外部公开搜索，仍检查关键字符串非空，防止异常替身或未来适配器以不完整身份构建可保存候选。 */
function isUsableRoot(root: JapaneseUpgradeRootCandidate | null): root is JapaneseUpgradeRootCandidate {
  return root !== null
    && typeof root.productUrl === "string" && root.productUrl.trim() !== ""
    && typeof root.canonicalTitle === "string" && root.canonicalTitle.trim() !== ""
    && typeof root.publisher === "string" && root.publisher.trim() !== "";
}

/** 对根 URL 去重但不缓存任何外部响应；仅避免同一批 Browser Run 为同一入口创建重复上下文。 */
function uniqueUsableRoots(roots: Iterable<JapaneseUpgradeRootCandidate | null>): JapaneseUpgradeRootCandidate[] {
  const unique = new Map<string, JapaneseUpgradeRootCandidate>();
  for (const root of roots) if (isUsableRoot(root) && !unique.has(root.productUrl)) unique.set(root.productUrl, root);
  return [...unique.values()];
}

/** Browser success 需同时提供字符串 URL；不完整对象不能被当作成功证据或被人工链接错误兜底。 */
function isBrowserSuccess(result: JapaneseUpgradeBrowserResult | undefined | null): result is Extract<JapaneseUpgradeBrowserResult, { status: "success" }> {
  return result?.status === "success" && typeof result.upgradeUrl === "string";
}

/** Browser 已分类失败才是人工链接可接受的临时不可用证据；未知对象、缺失结果和抛错均须拒绝。 */
function isSafeBrowserFailure(result: JapaneseUpgradeBrowserResult | undefined): boolean {
  return result?.status === "browser-unavailable"
    || result?.status === "timeout"
    || result?.status === "blocked-or-missing"
    || result?.status === "multiple-matches"
    || result?.status === "invalid-official-url";
}

/** 以根身份、严格日区 URL 与同 ID 的有效 JPY 报价重建候选；任何外部字段不完整时不产生半成品商品。 */
function candidateFromEvidence(
  root: JapaneseUpgradeRootCandidate,
  productUrl: string,
  quote: NintendoOfficialPriceQuote | null,
): OfficialProductCandidate | null {
  const officialPriceId = priceIdFromCanonicalUrl(productUrl);
  if (!isUsableRoot(root) || officialPriceId === null || !isValidJapaneseQuote(quote, officialPriceId)) return null;
  return {
    regionCode: "JP",
    productUrl,
    canonicalTitle: `${root.canonicalTitle} アップグレードパス`,
    publisher: root.publisher,
    productType: "upgrade-pack",
    currency: "JPY",
    coverUrl: null,
    currentPriceMinor: quote.currentPriceMinor,
    regularPriceMinor: quote.regularPriceMinor,
  };
}

/** 报价 ID、币种与金额均须可安全写入最小货币单位；非空常规价必须严格高于当前价，避免把无折扣或倒挂数据视为可信报价。 */
function isValidJapaneseQuote(quote: NintendoOfficialPriceQuote | null, officialPriceId: string): quote is NintendoOfficialPriceQuote {
  return quote !== null
    && quote.officialPriceId === officialPriceId
    && quote.currency === "JPY"
    && isNonNegativeSafeInteger(quote.currentPriceMinor)
    && (quote.regularPriceMinor === null || (isNonNegativeSafeInteger(quote.regularPriceMinor) && quote.regularPriceMinor > quote.currentPriceMinor));
}

/** 金额必须是非负安全整数，避免异常替身或未来 API 变更把小数、负数或精度丢失的数据写入候选。 */
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 发现失败统一使用稳定人工链接状态，前端无需读取不稳定的浏览器、网络或价格服务错误。 */
function needsManualLink(): JapaneseUpgradeDiscoveryResult {
  return { status: "needs-manual-link", message: manualMessage };
}

/** 保存前只接受本流程的两种来源；manual_selection 必须走通用地区确认，不能借此绕过升级包关系证据。 */
function isConfirmationSource(source: RegionalProductMatchSource): source is "automatic" | "manual_link" {
  return source === "automatic" || source === "manual_link";
}

/** 在根检索前完成候选固定字段检查，确保非 JP/JPY、非升级包、带封面或非 canonical URL 的提交不触发外部调用。 */
function hasBasicJapaneseUpgradeCandidateShape(candidate: OfficialProductCandidate, canonicalUrl: string | null): boolean {
  return candidate.regionCode === "JP"
    && candidate.productType === "upgrade-pack"
    && candidate.currency === "JPY"
    && candidate.coverUrl === null
    && canonicalUrl !== null;
}

/** 候选展示身份必须与同次唯一根完全一致；价格允许在最终复核时刷新，但浏览器提交的标题或发行商不能取代官方根。 */
function candidateMatchesRootIdentity(candidate: OfficialProductCandidate, root: JapaneseUpgradeRootCandidate, canonicalUrl: string): boolean {
  return candidate.productUrl === canonicalUrl
    && candidate.canonicalTitle === `${root.canonicalTitle} アップグレードパス`
    && candidate.publisher === root.publisher;
}

/** automatic 必须得到同 URL 的 Browser success；manual_link 可接受同 URL success 或安全失败，但成功指向其它 URL 是明确反证。 */
function relationAllowsSource(
  relation: JapaneseUpgradeBrowserResult | undefined,
  source: "automatic" | "manual_link",
  candidateUrl: string,
): boolean {
  if (isBrowserSuccess(relation)) return relation.upgradeUrl === candidateUrl;
  return source === "manual_link" && isSafeBrowserFailure(relation);
}
