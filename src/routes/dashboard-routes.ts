import type { DashboardService } from "../services/dashboard-service";
import { requireAdmin } from "./auth-guard";
import type { SessionReader } from "./auth-guard";

/** 当前本机开发期仪表盘可直接读取；价格历史与订阅名称仍受服务端查询边界约束，认证恢复前严禁部署。 */
export async function handleDashboardRoute(request: Request, sessions: SessionReader, dashboard: DashboardService): Promise<Response | null> {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/api/dashboard") return null;
  if (!(await requireAdmin(request, sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  return Response.json(await dashboard.getOverview());
}
