import { initialRegionCodes, type RegionCode } from "../../shared/domain";
import type { ProductType } from "../providers/types";
import type { OfficialPriceIdCandidate } from "../services/official-price-id-service";
import type { OfficialProductDiscoveryService } from "../services/official-product-discovery-service";
import { SubscriptionPreviewService } from "../services/subscription-preview-service";
import { requireAdmin } from "./auth-guard";

/**
 * 管理员在创建订阅前确认各区商品后调用的只读来源预览入口。该路由只校验公开候选信息并显示官方/第三方决策，
 * 刻意不写入游戏、地区商品或订阅记录；这样管理员取消或修改选择时不会留下会被采集器误用的半成品映射。
 */
export async function handleProductRoute(
  request: Request,
  database: D1Database,
  preview: SubscriptionPreviewService,
  discovery?: Pick<OfficialProductDiscoveryService, "searchDefaultRegion">,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // 精确白名单避免商品路由截获静态资源或未来端点；搜索服务未注入时保留旧预览路由的可测试性。
  const isPreview = request.method === "POST" && path === "/api/products/preview-sources";
  const isSearch = request.method === "POST" && path === "/api/products/search" && discovery !== undefined;
  if (!isPreview && !isSearch) return null;

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
    const candidates = readConfirmationCandidates(await request.json<unknown>());
    // 服务只产生瞬时 DTO；即使官方验证失败，异常也不会把用户 URL、外部响应或秘密写入 D1。
    return Response.json({ regions: await preview.create(candidates) });
  } catch (error) {
    // 表单问题可以安全反馈给管理员；其他错误统一隐藏网络、解析和数据库内部细节。
    const isValidationError = error instanceof ProductPreviewRequestError;
    return Response.json(
      {
        code: isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        error: isValidationError ? error.message : "商品来源预览暂时无法生成，请稍后重试。",
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
 * 每个字段均在 Worker 边界完成基础验证：URL 只接受 HTTPS，发行商允许 null，其他身份字段不能留空。
 * 更细的日区主机/路径和官方 ID 校验仍由 OfficialPriceIdService 负责，其他地区则明确预告第三方回退。
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

/** 货币使用三位大写 ISO 形式；具体是否为该地区正确币种由地区专用官方适配器再行验证。 */
function readCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    throw new ProductPreviewRequestError("货币代码无效。");
  }
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
