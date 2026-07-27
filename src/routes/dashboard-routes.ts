import { DashboardService } from "../services/dashboard-service";
import { LegacyDashboardRepository } from "../repositories/dashboard-repository";
import { requireAdmin } from "./auth-guard";

/** 仪表盘读取入口只允许管理员会话访问，价格历史和订阅名称不应成为公开可枚举的数据。 */
export async function handleDashboardRoute(request: Request, database: D1Database): Promise<Response | null> {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/api/dashboard") return null;
  if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  // 临时 D1 reader 只维持 Worker 回归；Node 装配会注入 PostgreSQL reader，最终迁出时删除此桥接。
  return Response.json(await new DashboardService(new LegacyDashboardRepository(database)).getOverview());
}
