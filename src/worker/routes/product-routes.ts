import {
  initialRegionCodes,
  regionalProductMatchSources,
  type ConfirmedRegionalProduct,
  type ConfirmedSubscriptionInput,
  type OfficialProductCandidate,
  type RegionCode,
} from "../../shared/domain";
import type { ProductType } from "../providers/types";
import type { OfficialPriceIdCandidate } from "../services/official-price-id-service";
import { JapaneseUpgradeBatchLimitError } from "../providers/japanese-upgrade-browser";
import { ProductDiscoveryError, type OfficialProductDiscoveryService } from "../services/official-product-discovery-service";
import { SubscriptionConfirmationError, type SubscriptionConfirmationService } from "../services/subscription-confirmation-service";
import { SubscriptionPreviewService } from "../services/subscription-preview-service";
import { requireAdmin } from "./auth-guard";

/**
 * 管理员商品发现、来源预览与最终确认的统一入口。搜索、链接解析、跨区匹配和来源预览保持只读；
 * 只有最终确认端点会交给服务层执行一个已完整验证的 D1 原子批次，避免向导中途取消时留下半成品映射。
 */
export async function handleProductRoute(
  request: Request,
  database: D1Database,
  preview: SubscriptionPreviewService,
  discovery?: Pick<OfficialProductDiscoveryService, "searchDefaultRegion" | "resolveOfficialLink" | "resolveRegions">,
  confirmation?: Pick<SubscriptionConfirmationService, "confirm">,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // 精确白名单避免商品路由截获静态资源或未来端点；发现服务未注入时保留旧预览路由的可测试性。
  const isPreview = request.method === "POST" && path === "/api/products/preview-sources";
  const isSearch = request.method === "POST" && path === "/api/products/search" && discovery !== undefined;
  const isResolveLink = request.method === "POST" && path === "/api/products/resolve-link" && discovery !== undefined;
  const isResolveRegions = request.method === "POST" && path === "/api/products/resolve-regions" && discovery !== undefined;
  const isConfirmSubscriptions = request.method === "POST" && path === "/api/products/confirm-subscriptions" && confirmation !== undefined;
  if (!isPreview && !isSearch && !isResolveLink && !isResolveRegions && !isConfirmSubscriptions) return null;

  // 必须先验证管理员会话才解析请求体或访问官方接口，避免匿名调用借预览端点放大任天堂请求负载。
  if (!(await requireAdmin(request, database))) {
    return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  }

  try {
    if (isSearch && discovery) {
      // 查询长度在 Worker 边界限制为 1..100，避免匿名以外的管理员也能把超长文本原样转发给官网公开搜索服务。
      const query = readSearchQuery(await request.json<unknown>());
      return Response.json(await discovery.searchDefaultRegion(query));
    }
    if (isResolveLink && discovery) {
      // 链接与可选完整锚点均交给服务端验证；锚点只用于日区升级包关系证明，浏览器不得以任意标题或币种伪造商品身份。
      const { regionCode, productUrl, anchor } = readOfficialLinkRequest(await request.json<unknown>());
      // 未提供锚点的既有普通商品调用保持双参数契约；仅在完整锚点实际存在时扩展到日区升级包关系核验，避免旧注入服务收到多余 undefined 参数。
      const candidate = anchor === undefined
        ? await discovery.resolveOfficialLink(regionCode, productUrl)
        : await discovery.resolveOfficialLink(regionCode, productUrl, anchor);
      return Response.json({ candidate });
    }
    if (isResolveRegions && discovery) {
      // 只收窄已选默认区候选；启用地区由发现服务从持久化设置读取，浏览器不能借请求体扩大或缩小官方检索范围。
      const { candidates } = readRegionResolutionRequest(await request.json<unknown>());
      const regions = await discovery.resolveRegions(candidates);
      // 服务提供日区 Browser Run 的脱敏原因时优先显示；其他人工链接状态沿用既有通用提示，维持客户端 DTO 的稳定非空消息约束。
      return Response.json({ regions: regions.map((region) => region.status === "needs-manual-link"
        ? { ...region, message: region.message ?? "请粘贴该区任天堂官方商品链接" }
        : region) });
    }
    if (isConfirmSubscriptions && confirmation) {
      // 仅把运行时收窄后的完整候选交给确认服务；服务会再次请求每个官方链接，路由绝不直接拼写游戏或订阅 SQL。
      const subscriptions = readSubscriptionConfirmationRequest(await request.json<unknown>());
      const results = await confirmation.confirm(subscriptions, new Date().toISOString());
      // 批量中含任一新建项才使用 201；全部为既有订阅时返回 200，前端可安全跳转既有编辑页而非误报失败。
      return Response.json({ subscriptions: results }, { status: results.some((result) => result.status === "created") ? 201 : 200 });
    }
    const candidates = readConfirmationCandidates(await request.json<unknown>());
    // 服务只产生瞬时 DTO；即使官方验证失败，异常也不会把用户 URL、外部响应或秘密写入 D1。
    return Response.json({ regions: await preview.create(candidates) });
  } catch (error) {
    // 表单问题可以安全反馈给管理员；其他错误统一隐藏网络、解析和数据库内部细节。
    const isValidationError = error instanceof ProductPreviewRequestError
      || error instanceof ProductDiscoveryError
      || error instanceof SubscriptionConfirmationError
      || error instanceof JapaneseUpgradeBatchLimitError;
    return Response.json(
      {
        code: isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        // 领域错误均是服务端预设中文文案，可安全提示管理员；网络、页面解析与 D1 错误永远不回显给浏览器。
        error: isValidationError ? error.message : "官方商品信息暂时无法获取，请稍后重试。",
      },
      { status: isValidationError ? 422 : 500 },
    );
  }
}

/** 名称搜索只接受去除首尾空白后的有限长度文本，地区始终由服务端设置决定，浏览器不能附带地区覆盖字段。 */
function readSearchQuery(value: unknown): string {
  if (!isRecord(value) || typeof value.query !== "string") throw new ProductPreviewRequestError("搜索名称无效。");
  const query = value.query.trim();
  if (query.length === 0 || query.length > 100) throw new ProductPreviewRequestError("搜索名称长度应为 1 到 100 个字符。");
  return query;
}

/** 手动补充入口只接受支持地区与 HTTPS 链接；具体任天堂主机/路径仍在发现服务中统一验证，避免路由复制安全白名单。 */
function readOfficialLinkRequest(value: unknown): { regionCode: RegionCode; productUrl: string; anchor?: OfficialProductCandidate } {
  if (!isRecord(value)) throw new ProductPreviewRequestError("请求内容必须是对象。");
  // 可选锚点若出现就必须是完整官方候选；不能接受只含标题的浏览器对象，以免日区升级包关系服务失去类型与身份约束。
  const anchor = "anchor" in value ? readOfficialProductCandidate(value.anchor) : undefined;
  return { regionCode: readRegionCode(value.regionCode), productUrl: readHttpsUrl(value.productUrl), anchor };
}

/**
 * 跨区解析只消费由默认区官方搜索或官方链接解析得到的完整瞬时候选。所有字段在路由边界收窄，
 * 因为这些值虽来自浏览器提交，却会影响后续的官方检索关键词与界面匹配状态，不能信任客户端对象形状。
 */
function readRegionResolutionRequest(value: unknown): { candidates: OfficialProductCandidate[] } {
  if (!isRecord(value)) throw new ProductPreviewRequestError("请求内容必须是对象。");
  if ("enabledRegions" in value) throw new ProductPreviewRequestError("跨区范围由已保存设置决定。");
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new ProductPreviewRequestError("请至少选择一个官方商品。");
  }
  const candidates = value.candidates.map((candidate) => readOfficialProductCandidate(candidate));
  // 一个候选键只能表示一个已验证默认区商品；重复提交会制造重复地区确认卡，故在写入前的只读阶段即拒绝。
  const candidateKeys = candidates.map((candidate) => `${candidate.regionCode}:${candidate.productUrl}`);
  if (new Set(candidateKeys).size !== candidateKeys.length) throw new ProductPreviewRequestError("不能重复选择同一官方商品。");
  return { candidates };
}

/**
 * 最终确认请求必须包含至少一个游戏；每项由默认区候选和非空地区映射构成。这里仅做 JSON 形态与受控枚举校验，
 * 真实官方链接、身份与价格 ID 验证仍由服务层重做，防止管理员旧页面或篡改请求绕过外部来源安全边界。
 */
function readSubscriptionConfirmationRequest(value: unknown): ConfirmedSubscriptionInput[] {
  if (!isRecord(value) || !Array.isArray(value.subscriptions) || value.subscriptions.length === 0) {
    throw new ProductPreviewRequestError("请至少确认一个商品订阅。");
  }
  return value.subscriptions.map((subscription) => readConfirmedSubscription(subscription));
}

/** 每个游戏至少保留一个地区，且同一区不能重复；区域身份最终由确认服务在官方页面重读后再次比较。 */
function readConfirmedSubscription(value: unknown): ConfirmedSubscriptionInput {
  if (!isRecord(value) || !Array.isArray(value.regions) || value.regions.length === 0) {
    throw new ProductPreviewRequestError("每个游戏至少确认一个地区商品。");
  }
  const selected = readOfficialProductCandidate(value.selected);
  const regions = value.regions.map((region) => readConfirmedRegionalProduct(region));
  if (new Set(regions.map((region) => region.regionCode)).size !== regions.length) {
    throw new ProductPreviewRequestError("每个游戏在每区只能确认一个商品。");
  }
  const skippedRegionCodes = readSkippedRegionCodes(value.skippedRegionCodes);
  return { selected, regions, skippedRegionCodes };
}

/**
 * 跳过地区必须显式提交数组，即使为空也不能省略。路由先做枚举和去重检查，
 * 服务层随后以当前设置验证其与已确认地区的覆盖和互斥关系，避免把浏览器输入当作地区事实来源。
 */
function readSkippedRegionCodes(value: unknown): RegionCode[] {
  if (!Array.isArray(value)) throw new ProductPreviewRequestError("跳过地区设置无效。");
  const regionCodes = value.map((regionCode) => readRegionCode(regionCode));
  if (new Set(regionCodes).size !== regionCodes.length) throw new ProductPreviewRequestError("跳过地区不能重复。");
  return regionCodes;
}

/** 路由输入错误使用独立类型，避免把管理员表单问题误记为来源适配器或数据库故障。 */
class ProductPreviewRequestError extends Error {}

/** 首版只允许持久化模型认可的商品分类，拒绝任意字符串以防后续确认流程写入不可验证的分类。 */
const supportedProductTypes: readonly ProductType[] = ["game", "upgrade-pack", "dlc", "season-pass", "bundle", "other"];

/**
 * 将不可信 JSON 逐字段收窄为官方 ID 确认服务的公开候选。每区只能有一个候选，
 * 因为一个地区商品只能绑定一个官方价格 ID；重复选择必须由管理员在确认页面先解决，不能静默覆盖。
 */
function readConfirmationCandidates(value: unknown): OfficialPriceIdCandidate[] {
  if (!isRecord(value)) throw new ProductPreviewRequestError("请求内容必须是对象。");
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new ProductPreviewRequestError("请至少确认一个地区商品。");
  }

  const candidates = value.candidates.map((candidate) => readCandidate(candidate));
  if (new Set(candidates.map((candidate) => candidate.regionCode)).size !== candidates.length) {
    throw new ProductPreviewRequestError("每个地区只能确认一个商品。");
  }
  return candidates;
}

/**
 * 发现候选在身份字段之外包含公开封面和最小货币单位价格。价格允许为 null，以表达官方公开结果未给出报价；
 * 但只要出现数值，就必须是非负安全整数，避免浮点或负数在前端折扣与后续确认中产生错误语义。
 */
function readOfficialProductCandidate(value: unknown): OfficialProductCandidate {
  if (!isRecord(value)) throw new ProductPreviewRequestError("官方商品信息无效。");
  const identity = readCandidate(value);
  const coverUrl = value.coverUrl === null ? null : readHttpsUrl(value.coverUrl);
  const currentPriceMinor = readNullableMinorPrice(value.currentPriceMinor, "当前价格无效。");
  const regularPriceMinor = readNullableMinorPrice(value.regularPriceMinor, "原价无效。");
  if (currentPriceMinor !== null && regularPriceMinor !== null && regularPriceMinor < currentPriceMinor) {
    throw new ProductPreviewRequestError("原价不能低于当前价格。");
  }
  return { ...identity, coverUrl, currentPriceMinor, regularPriceMinor };
}

/** 匹配来源为审计字段，必须使用稳定枚举；不能让浏览器自由填写后被误当成系统自动匹配。 */
function readConfirmedRegionalProduct(value: unknown): ConfirmedRegionalProduct {
  if (!isRecord(value)) throw new ProductPreviewRequestError("地区商品信息无效。");
  const candidate = readOfficialProductCandidate(value);
  if (typeof value.matchSource !== "string" || !regionalProductMatchSources.includes(value.matchSource as ConfirmedRegionalProduct["matchSource"])) {
    throw new ProductPreviewRequestError("地区商品匹配来源无效。");
  }
  return { ...candidate, matchSource: value.matchSource as ConfirmedRegionalProduct["matchSource"] };
}

/**
 * 每个字段均在 Worker 边界完成基础验证：URL 只接受 HTTPS，发行商允许 null，其他身份字段不能留空。
 * 来源预览仍由 OfficialPriceIdService 按地区验证官方价格 ID；跨区发现会在服务层额外校验任天堂主机与路径，
 * 因而此基础收窄不能被误当成官方链接认证。
 */
function readCandidate(value: unknown): OfficialPriceIdCandidate {
  if (!isRecord(value)) throw new ProductPreviewRequestError("地区商品信息无效。");
  const regionCode = readRegionCode(value.regionCode);
  const currency = readCurrency(value.currency);
  const productUrl = readHttpsUrl(value.productUrl);
  const canonicalTitle = readNonEmptyString(value.canonicalTitle, "商品标题无效。");
  const publisher = value.publisher === null ? null : readNonEmptyString(value.publisher, "发行商信息无效。");
  const productType = readProductType(value.productType);
  return { regionCode, currency, productUrl, canonicalTitle, publisher, productType };
}

/** 仅接受首版支持的五区代码，防止将未知地区传入尚无来源策略与货币规则的确认服务。 */
function readRegionCode(value: unknown): RegionCode {
  if (typeof value !== "string" || !initialRegionCodes.includes(value as RegionCode)) {
    throw new ProductPreviewRequestError("地区代码无效。");
  }
  return value as RegionCode;
}

/** 启用地区至少一个且不能重复；重复地区会让同一游戏产生两份相同的人工确认任务。 */
function readRegionCodes(value: unknown): RegionCode[] {
  if (!Array.isArray(value) || value.length === 0) throw new ProductPreviewRequestError("请至少选择一个启用地区。");
  const regions = value.map((regionCode) => readRegionCode(regionCode));
  if (new Set(regions).size !== regions.length) throw new ProductPreviewRequestError("启用地区不能重复。");
  return regions;
}

/** 货币使用三位大写 ISO 形式；具体是否为该地区正确币种由地区专用官方适配器再行验证。 */
function readCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new ProductPreviewRequestError("货币代码无效。");
  }
  return value;
}

/** 公开价格统一以货币最小单位传输；null 用于“官方结果未验证出价格”，不会伪造成免费商品。 */
function readNullableMinorPrice(value: unknown, message: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProductPreviewRequestError(message);
  return value;
}

/**
 * 预览仅接受 HTTPS 商品地址，避免管理员误把本地、脚本或明文 HTTP 链接传给后续官方验证器。
 * 不在这里限制具体任天堂主机，以便非日区在官方解析器未落地前仍可获得明确的第三方回退预告。
 */
function readHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ProductPreviewRequestError("商品链接无效。");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new ProductPreviewRequestError("商品链接必须使用 HTTPS。");
    return url.toString();
  } catch (error) {
    if (error instanceof ProductPreviewRequestError) throw error;
    throw new ProductPreviewRequestError("商品链接无效。");
  }
}

/** 商品类型只能来自采集器的稳定枚举，避免同名 DLC、本体或升级包在预览阶段被错误归类。 */
function readProductType(value: unknown): ProductType {
  if (typeof value !== "string" || !supportedProductTypes.includes(value as ProductType)) {
    throw new ProductPreviewRequestError("商品类型无效。");
  }
  return value as ProductType;
}

/** 普通对象检查阻止数组、null 等 JSON 形态穿透到字段读取，保持所有失败均是可控的 422 响应。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 空白身份字段没有可靠匹配含义，必须在预览前拒绝而不是让来源服务根据不完整候选猜测。 */
function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ProductPreviewRequestError(message);
  return value.trim();
}
