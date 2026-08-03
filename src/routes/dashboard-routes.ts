import { DashboardRepository } from "../repositories/d1/dashboard-repository";
import { DashboardService } from "../services/dashboard-service";
import { requireAdmin } from "./auth-guard";

/** 仪表盘读取入口只允许管理员会话访问，价格历史和订阅名称不应成为公开可枚举的数据。 */
export async function handleDashboardRoute(request: Request, database: D1Database): Promise<Response | null> {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/api/dashboard") return null;
  if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  // Task 3 仅把 SQL 移入仓储端口；路由仍接收原 D1 绑定，后续 Node 装配迁移前保持认证与请求边界不变。
  return Response.json(await new DashboardService(new DashboardRepository(database)).getOverview());
}
