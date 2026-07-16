import { SubscriptionRepository } from "../repositories/subscription-repository";
import { RegionalProductMismatchError, SubscriptionService } from "../services/subscription-service";
import { requireAdmin } from "./auth-guard";

/**
 * 管理订阅创建入口。所有写入均在会话守卫之后执行，防止第三方仅凭公开商品 ID 改变采集和通知范围。
 * 商品搜索、跨区匹配和地区编辑将在各自的 API 中实现；本路由只消费管理员已确认的 ID 列表。
 */
export async function handleSubscriptionRoute(request: Request, database: D1Database): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  // 未匹配的请求交还给主路由，避免此模块意外截获未来的订阅详情、更新或删除端点。
  if (request.method !== "POST" || path !== "/api/subscriptions") return null;

  // 认证失败统一使用固定响应，既不泄露会话是否过期，也不给匿名调用者数据库错误细节。
  if (!(await requireAdmin(request, database))) {
    return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  }

  try {
    const body = await request.json<unknown>();
    const input = readCreateSubscriptionInput(body);
    const result = await new SubscriptionService(new SubscriptionRepository(database)).createOrOpen(input, new Date().toISOString());
    // 只有真正插入时返回 201；重复提交返回 200 让前端按幂等成功处理，而不是误提示“创建失败”。
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    // 可预期的表单或商品归属错误使用 422；数据库故障则使用通用 500，任何路径都不回显 JSON、SQL 或堆栈。
    const isValidationError = error instanceof SubscriptionRequestError || error instanceof RegionalProductMismatchError;
    return Response.json(
      {
        code: isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        error: isValidationError && error instanceof Error ? error.message : "订阅暂时无法创建，请稍后重试。",
      },
      { status: isValidationError ? 422 : 500 },
    );
  }
}

/** 路由专属参数错误避免复用认证错误语义，让日志与前端能够区分登录和订阅表单问题。 */
class SubscriptionRequestError extends Error {}

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

/** 只接受普通对象形态，数组、null 与原型对象都不应被当作浏览器表单提交解析。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 标识符保留原值供 D1 外键查询，但拒绝空白字符串，避免前端无选择时形成难诊断的关系错误。 */
function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new SubscriptionRequestError(message);
  return value;
}
