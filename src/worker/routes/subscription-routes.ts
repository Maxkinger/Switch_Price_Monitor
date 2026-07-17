import { SubscriptionRepository } from "../repositories/subscription-repository";
import {
  RegionalProductMismatchError,
  SubscriptionNotFoundError,
  SubscriptionService,
} from "../services/subscription-service";
import { requireAdmin } from "./auth-guard";

/**
 * 管理订阅创建入口。所有写入均在会话守卫之后执行，防止第三方仅凭公开商品 ID 改变采集和通知范围。
 * 商品搜索、跨区匹配和地区编辑将在各自的 API 中实现；本路由只消费管理员已确认的 ID 列表。
 */
export async function handleSubscriptionRoute(request: Request, database: D1Database): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const action = readSubscriptionAction(request.method, path);
  // 未匹配的请求交还给主路由，避免此模块意外截获未来的商品发现、历史或静态资源端点。
  if (!action) return null;

  // 认证失败统一使用固定响应，既不泄露会话是否过期，也不给匿名调用者数据库错误细节。
  if (!(await requireAdmin(request, database))) {
    return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  }

  try {
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
    const isValidationError = error instanceof SubscriptionRequestError || error instanceof RegionalProductMismatchError;
    const isNotFound = error instanceof SubscriptionNotFoundError;
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
  | { kind: "disable"; subscriptionId: string }
  | { kind: "set-enabled"; subscriptionId: string };

/**
 * 支持首版已确认的创建、停用与重新启用端点。URL 中的 ID 会解码后再以参数化 SQL 传递，
 * 不能拼入查询文本；空 ID 仍交由未匹配路径处理，避免对无效地址泄露订阅存在性。
 */
function readSubscriptionAction(method: string, path: string): SubscriptionAction | null {
  if (method === "POST" && path === "/api/subscriptions") return { kind: "create" };
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
