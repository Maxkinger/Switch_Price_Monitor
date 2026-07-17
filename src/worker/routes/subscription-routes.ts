import { initialRegionCodes, regionalProductMatchSources, type ConfirmedRegionalProduct, type RegionCode } from "../../shared/domain";
import type { ProductType } from "../providers/types";
import { SubscriptionRepository } from "../repositories/subscription-repository";
import { SubscriptionDetailRepository } from "../repositories/subscription-detail-repository";
import { SubscriptionDetailService } from "../services/subscription-detail-service";
import {
  SubscriptionRegionCompletionError,
  SubscriptionRegionCompletionNotFoundError,
  type CompletionRegionsInput,
  type SubscriptionRegionCompletionService,
} from "../services/subscription-region-completion-service";
import {
  RegionalProductMismatchError,
  SubscriptionNotFoundError,
  SubscriptionService,
} from "../services/subscription-service";
import { requireAdmin } from "./auth-guard";

/**
 * 管理订阅读取、编辑与已有地区补全入口。所有写入均在会话守卫之后执行，防止第三方仅凭公开商品 ID 改变采集和通知范围。
 * 已有地区补全只把受控 JSON 交给服务；游戏归属、跨区范围和任天堂官方复核均保持在 Worker 内，不由浏览器决定。
 */
export async function handleSubscriptionRoute(
  request: Request,
  database: D1Database,
  completion?: Pick<SubscriptionRegionCompletionService, "resolveExisting" | "completeExisting">,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const action = readSubscriptionAction(request.method, path);
  // 未匹配的请求交还给主路由，避免此模块意外截获未来的商品发现、历史或静态资源端点。
  if (!action) return null;

  // 认证失败统一使用固定响应，既不泄露会话是否过期，也不给匿名调用者数据库错误细节。
  if (!(await requireAdmin(request, database))) {
    return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  }

  try {
    if (action.kind === "read") {
      // 详情只经受保护服务返回脱敏读取模型，不能把路由层的数据库行、会话或来源原始响应直接序列化给浏览器。
      const detail = await new SubscriptionDetailService(new SubscriptionDetailRepository(database)).get(action.subscriptionId);
      return Response.json(detail);
    }

    if (action.kind === "resolve-regions") {
      if (!completion) throw new SubscriptionRequestError("订阅地区补全暂不可用。");
      // 请求体被有意忽略：补全范围由服务内的保存设置和订阅锚点决定，浏览器不能以地区数组扩大或缩小它。
      return Response.json(await completion.resolveExisting(action.subscriptionId));
    }

    if (action.kind === "complete-regions") {
      if (!completion) throw new SubscriptionRequestError("订阅地区补全暂不可用。");
      const input = readCompletionRegionsInput(await request.json<unknown>());
      return Response.json(await completion.completeExisting(action.subscriptionId, input, new Date().toISOString()));
    }

    const service = new SubscriptionService(new SubscriptionRepository(database));
    if (action.kind === "create") {
      const input = readCreateSubscriptionInput(await request.json<unknown>());
      const result = await service.createOrOpen(input, new Date().toISOString());
      // 只有真正插入时返回 201；重复提交返回 200 让前端按幂等成功处理，而不是误提示“创建失败”。
      return Response.json(result, { status: result.created ? 201 : 200 });
    }

    if (action.kind === "disable") {
      await service.setEnabled(action.subscriptionId, false, new Date().toISOString());
      // 停用成功不回传旧配置，防止前端把过期详情误当作仍可采集的状态；读取接口会提供最新显示模型。
      return new Response(null, { status: 204 });
    }

    const update = readSubscriptionUpdate(await request.json<unknown>());
    if (update.kind === "enabled") { await service.setEnabled(action.subscriptionId, update.enabled, new Date().toISOString()); return Response.json({ subscriptionId: action.subscriptionId, enabled: update.enabled }); }
    if (update.kind === "regions") { await service.replaceRegionalProducts(action.subscriptionId, update.regionalProductIds, new Date().toISOString()); return Response.json({ subscriptionId: action.subscriptionId, regionalProductIds: update.regionalProductIds }); }
    await service.setTargets(action.subscriptionId, update.globalTargetCnyFen, update.regionTargets, new Date().toISOString());
    return Response.json({ subscriptionId: action.subscriptionId, globalTargetCnyFen: update.globalTargetCnyFen, regionTargets: update.regionTargets });
  } catch (error) {
    // 可预期的表单或商品归属错误使用 422；数据库故障则使用通用 500，任何路径都不回显 JSON、SQL 或堆栈。
    const isValidationError = error instanceof SubscriptionRequestError || error instanceof RegionalProductMismatchError || error instanceof SubscriptionRegionCompletionError;
    const isNotFound = error instanceof SubscriptionNotFoundError || error instanceof SubscriptionRegionCompletionNotFoundError;
    return Response.json(
      {
        code: isNotFound ? "NOT_FOUND" : isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        error: (isValidationError || isNotFound) && error instanceof Error ? error.message : "订阅暂时无法处理，请稍后重试。",
      },
      { status: isNotFound ? 404 : isValidationError ? 422 : 500 },
    );
  }
}

/** 路由专属参数错误避免复用认证错误语义，让日志与前端能够区分登录和订阅表单问题。 */
class SubscriptionRequestError extends Error {}

/** 路由动作收窄后才访问路径中的订阅 ID，避免未来新增子路径时被宽松字符串判断错误消费。 */
type SubscriptionAction =
  | { kind: "create" }
  | { kind: "read"; subscriptionId: string }
  | { kind: "resolve-regions"; subscriptionId: string }
  | { kind: "complete-regions"; subscriptionId: string }
  | { kind: "disable"; subscriptionId: string }
  | { kind: "set-enabled"; subscriptionId: string };

/**
 * 支持首版已确认的创建、停用与重新启用端点。URL 中的 ID 会解码后再以参数化 SQL 传递，
 * 不能拼入查询文本；空 ID 仍交由未匹配路径处理，避免对无效地址泄露订阅存在性。
 */
function readSubscriptionAction(method: string, path: string): SubscriptionAction | null {
  if (method === "POST" && path === "/api/subscriptions") return { kind: "create" };
  const readMatch = method === "GET" ? path.match(/^\/api\/subscriptions\/([^/]+)$/) : null;
  if (readMatch) return { kind: "read", subscriptionId: decodeURIComponent(readMatch[1]) };
  const resolveRegionsMatch = method === "POST" ? path.match(/^\/api\/subscriptions\/([^/]+)\/resolve-regions$/) : null;
  if (resolveRegionsMatch) return { kind: "resolve-regions", subscriptionId: decodeURIComponent(resolveRegionsMatch[1]) };
  const completeRegionsMatch = method === "POST" ? path.match(/^\/api\/subscriptions\/([^/]+)\/complete-regions$/) : null;
  if (completeRegionsMatch) return { kind: "complete-regions", subscriptionId: decodeURIComponent(completeRegionsMatch[1]) };
  const disableMatch = method === "POST" ? path.match(/^\/api\/subscriptions\/([^/]+)\/disable$/) : null;
  if (disableMatch) return { kind: "disable", subscriptionId: decodeURIComponent(disableMatch[1]) };
  const updateMatch = method === "PATCH" ? path.match(/^\/api\/subscriptions\/([^/]+)$/) : null;
  if (updateMatch) return { kind: "set-enabled", subscriptionId: decodeURIComponent(updateMatch[1]) };
  return null;
}

/**
 * 将不可信 JSON 收窄为订阅服务所需的三个字段。地区商品列表必须非空且去重，
 * 防止空订阅占用游戏唯一约束或重复 ID 触发关系表主键错误。
 */
function readCreateSubscriptionInput(value: unknown): { id: string; gameId: string; regionalProductIds: string[] } {
  if (!isRecord(value)) throw new SubscriptionRequestError("请求内容必须是对象。");
  const id = readNonEmptyString(value.id, "订阅标识无效。");
  const gameId = readNonEmptyString(value.gameId, "游戏标识无效。");
  if (!Array.isArray(value.regionalProductIds) || value.regionalProductIds.length === 0) {
    throw new SubscriptionRequestError("请至少选择一个地区商品。");
  }
  const regionalProductIds = value.regionalProductIds.map((productId) => readNonEmptyString(productId, "地区商品标识无效。"));
  if (new Set(regionalProductIds).size !== regionalProductIds.length) {
    throw new SubscriptionRequestError("地区商品不能重复选择。");
  }
  return { id, gameId, regionalProductIds };
}

/**
 * 补全请求不接受游戏 ID、现有商品 ID 或自定义地区范围；这些身份与范围均由服务从 D1/设置读取。
 * 新候选只做严格 JSON 和受控枚举收窄，服务仍会重新解析每个任天堂官方链接后才可能进入原子写入。
 */
function readCompletionRegionsInput(value: unknown): CompletionRegionsInput {
  if (!isRecord(value) || !Array.isArray(value.regions) || !Array.isArray(value.skippedRegionCodes)) {
    throw new SubscriptionRequestError("补全地区设置无效。");
  }
  if ("enabledRegions" in value) throw new SubscriptionRequestError("跨区范围由已保存设置决定。");
  const regions = value.regions.map((region) => readConfirmedRegionalProduct(region));
  const skippedRegionCodes = value.skippedRegionCodes.map((regionCode) => readRegionCode(regionCode));
  if (new Set(regions.map((region) => region.regionCode)).size !== regions.length || new Set(skippedRegionCodes).size !== skippedRegionCodes.length) {
    throw new SubscriptionRequestError("补全地区不能重复。");
  }
  return { regions, skippedRegionCodes };
}

/** 区域候选的公开字段会影响官方页面复核与身份比较，因此路由拒绝缺失、负数和非 HTTPS 的浏览器载荷。 */
function readConfirmedRegionalProduct(value: unknown): ConfirmedRegionalProduct {
  if (!isRecord(value)) throw new SubscriptionRequestError("地区商品信息无效。");
  if (typeof value.matchSource !== "string" || !regionalProductMatchSources.includes(value.matchSource as ConfirmedRegionalProduct["matchSource"])) {
    throw new SubscriptionRequestError("地区商品匹配来源无效。");
  }
  const currentPriceMinor = readNullableMinorPrice(value.currentPriceMinor, "当前价格无效。");
  const regularPriceMinor = readNullableMinorPrice(value.regularPriceMinor, "原价无效。");
  if (currentPriceMinor !== null && regularPriceMinor !== null && regularPriceMinor < currentPriceMinor) {
    throw new SubscriptionRequestError("原价不能低于当前价格。");
  }
  return {
    regionCode: readRegionCode(value.regionCode),
    productUrl: readHttpsUrl(value.productUrl),
    canonicalTitle: readNonEmptyString(value.canonicalTitle, "商品标题无效。"),
    publisher: value.publisher === null ? null : readNonEmptyString(value.publisher, "发行商信息无效。"),
    productType: readProductType(value.productType),
    currency: readCurrency(value.currency),
    coverUrl: value.coverUrl === null ? null : readHttpsUrl(value.coverUrl),
    currentPriceMinor,
    regularPriceMinor,
    matchSource: value.matchSource as ConfirmedRegionalProduct["matchSource"],
  };
}

/** 首版地区枚举同时约束设置和官方适配器，拒绝未知代码避免将其转交给没有安全白名单的来源实现。 */
function readRegionCode(value: unknown): RegionCode {
  if (typeof value !== "string" || !initialRegionCodes.includes(value as RegionCode)) throw new SubscriptionRequestError("地区代码无效。");
  return value as RegionCode;
}

/** 货币仅采用三位大写 ISO 字符串；实际地区货币仍由官方页面解析器在服务层二次验证。 */
function readCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new SubscriptionRequestError("货币代码无效。");
  return value;
}

/** 公开价格使用最小货币单位；null 表示本次候选没有可靠公开报价，不能被转换为免费商品。 */
function readNullableMinorPrice(value: unknown, message: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SubscriptionRequestError(message);
  return value;
}

/** 仅允许 HTTPS URL 进入下一层官方白名单验证，拒绝脚本、本地和明文链接作为 Worker 外部请求目标。 */
function readHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new SubscriptionRequestError("商品链接无效。");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new SubscriptionRequestError("商品链接必须使用 HTTPS。");
    return url.toString();
  } catch (error) {
    if (error instanceof SubscriptionRequestError) throw error;
    throw new SubscriptionRequestError("商品链接无效。");
  }
}

/** 商品类型必须来自持久化和官方解析共同认可的稳定枚举，避免同名本体、DLC 与升级包被混写。 */
function readProductType(value: unknown): ProductType {
  const supported: readonly ProductType[] = ["game", "upgrade-pack", "dlc", "season-pass", "bundle", "other"];
  if (typeof value !== "string" || !supported.includes(value as ProductType)) throw new SubscriptionRequestError("商品类型无效。");
  return value as ProductType;
}

/** PATCH 只接受启用状态或完整目标价配置，禁止把地区商品编辑等尚未实现的字段静默忽略。 */
function readSubscriptionUpdate(value: unknown): { kind: "enabled"; enabled: boolean } | { kind: "regions"; regionalProductIds: string[] } | { kind: "targets"; globalTargetCnyFen: number | null; regionTargets: Array<{ regionCode: string; targetAmountMinor: number }> } {
  if (!isRecord(value)) throw new SubscriptionRequestError("请求内容必须是对象。");
  if (typeof value.enabled === "boolean") return { kind: "enabled", enabled: value.enabled };
  if (Array.isArray(value.regionalProductIds)) {
    const regionalProductIds = value.regionalProductIds.map((id) => readNonEmptyString(id, "地区商品标识无效。"));
    if (regionalProductIds.length === 0 || new Set(regionalProductIds).size !== regionalProductIds.length) throw new SubscriptionRequestError("地区商品选择无效。");
    return { kind: "regions", regionalProductIds };
  }
  if (!(value.globalTargetCnyFen === null || (Number.isInteger(value.globalTargetCnyFen) && (value.globalTargetCnyFen as number) > 0)) || !Array.isArray(value.regionTargets)) throw new SubscriptionRequestError("目标价设置无效。");
  const regionTargets = value.regionTargets.map((target) => {
    if (!isRecord(target) || typeof target.regionCode !== "string" || !Number.isInteger(target.targetAmountMinor) || (target.targetAmountMinor as number) <= 0) throw new SubscriptionRequestError("单区目标价无效。");
    return { regionCode: target.regionCode, targetAmountMinor: target.targetAmountMinor as number };
  });
  if (new Set(regionTargets.map((target) => target.regionCode)).size !== regionTargets.length) throw new SubscriptionRequestError("单区目标价不能重复。");
  return { kind: "targets", globalTargetCnyFen: value.globalTargetCnyFen as number | null, regionTargets };
}

/** 只接受普通对象形态，数组、null 与原型对象都不应被当作浏览器表单提交解析。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 标识符保留原值供 D1 外键查询，但拒绝空白字符串，避免前端无选择时形成难诊断的关系错误。 */
function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new SubscriptionRequestError(message);
  return value;
}
