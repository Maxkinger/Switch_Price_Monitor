import type { SessionReader } from "../services/auth-service";
import type { HistoryService } from "../services/history-service";
import { requireAdmin } from "./auth-guard";

/** 历史路由只消费会话和脱敏历史 DTO 服务，不接收 SQL executor 或数据库连接。 */
export interface HistoryRouteDependencies {
  sessions: SessionReader;
  history: Pick<HistoryService, "list">;
}

/** 历史价格包含长期消费行为线索，仅允许管理员会话读取。 */
export async function handleHistoryRoute(request: Request, dependencies: HistoryRouteDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/history") return null;
  if (!(await requireAdmin(request, dependencies.sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  const subscriptionId = url.searchParams.get("subscriptionId")?.trim();
  if (!subscriptionId) return Response.json({ code: "VALIDATION_ERROR", error: "订阅标识无效。" }, { status: 422 });
  const region = url.searchParams.get("region")?.trim() || null;
  return Response.json(await dependencies.history.list(subscriptionId, region));
}
