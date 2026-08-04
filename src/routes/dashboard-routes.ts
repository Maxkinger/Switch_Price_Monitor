import type { DashboardService } from "../services/dashboard-service";
import type { SessionReader } from "../services/auth-service";
import { requireAdmin } from "./auth-guard";

/** 仪表盘路由只接收会话判断和聚合服务，数据库实现由 Node/Worker 入口显式装配。 */
export interface DashboardRouteDependencies {
  sessions: SessionReader;
  dashboard: Pick<DashboardService, "getOverview">;
}

/** 仪表盘读取入口只允许管理员会话访问，价格历史和订阅名称不应成为公开可枚举的数据。 */
export async function handleDashboardRoute(request: Request, dependencies: DashboardRouteDependencies): Promise<Response | null> {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/api/dashboard") return null;
  if (!(await requireAdmin(request, dependencies.sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  return Response.json(await dependencies.dashboard.getOverview());
}
