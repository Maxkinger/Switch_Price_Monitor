import type { HistoryService } from "../services/history-service";
import { requireAdmin } from "./auth-guard";
import type { SessionReader } from "./auth-guard";

/** 当前本机开发期历史价格可直接读取；查询参数和 DTO 脱敏仍生效，认证恢复前禁止任何非本机部署。 */
export async function handleHistoryRoute(request: Request, sessions: SessionReader, history: HistoryService): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/history") return null;
  if (!(await requireAdmin(request, sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  const subscriptionId = url.searchParams.get("subscriptionId")?.trim();
  if (!subscriptionId) return Response.json({ code: "VALIDATION_ERROR", error: "订阅标识无效。" }, { status: 422 });
  const region = url.searchParams.get("region")?.trim() || null;
  return Response.json(await history.list(subscriptionId, region));
}
