import { HistoryService } from "../services/history-service";
import { LegacyHistoryRepository } from "../repositories/history-repository";
import { requireAdmin } from "./auth-guard";

/** 历史价格包含长期消费行为线索，仅允许管理员会话读取。 */
export async function handleHistoryRoute(request: Request, database: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/history") return null;
  if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  const subscriptionId = url.searchParams.get("subscriptionId")?.trim();
  if (!subscriptionId) return Response.json({ code: "VALIDATION_ERROR", error: "订阅标识无效。" }, { status: 422 });
  const region = url.searchParams.get("region")?.trim() || null;
  // 兼容 reader 不改变路由签名或认证边界，只把旧 D1 查询移出平台中立服务，待 Node 路由装配后删除。
  return Response.json(await new HistoryService(new LegacyHistoryRepository(database)).list(subscriptionId, region));
}
