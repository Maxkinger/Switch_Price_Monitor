import { ManualRefreshCooldownError, type ManualRefreshService } from "../services/manual-refresh-service";
import { requireAdmin } from "./auth-guard";
import type { SessionReader } from "./auth-guard";

/**
 * 当前本机开发期接收直接发起的手动刷新请求。端点在取得原子冷却名额后等待统一采集器完成，
 * 因此 200 仅表示本次采集已经结束；来源、汇率和健康状态仍由服务端运行器统一控制，认证恢复前严禁部署。
 */
export async function handleManualRefreshRoute(
  request: Request,
  sessions: SessionReader,
  service: ManualRefreshService,
): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/refresh") return null;
  if (!(await requireAdmin(request, sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

  try {
    const result = await service.refresh(new Date().toISOString());
    // 仅在统一采集器正常返回后才返回 completed；计数供界面提示，并由随后重新读取仪表盘展示持久化结果。
    return Response.json({ status: "completed", ...result });
  } catch (error) {
    if (error instanceof ManualRefreshCooldownError) {
      return Response.json({ code: "REFRESH_COOLDOWN", error: error.message, nextAllowedAt: error.nextAllowedAt }, { status: 429 });
    }
    // 持久化仓储或外部来源异常不回传表结构、商品链接和运行时堆栈，避免已登录浏览器脚本或日志采集器获得内部细节。
    return Response.json({ code: "INTERNAL_ERROR", error: "刷新暂时无法完成，请稍后重试。" }, { status: 500 });
  }
}
