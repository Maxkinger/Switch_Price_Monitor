import { ManualRefreshRepository } from "../repositories/manual-refresh-repository";
import { ManualRefreshCooldownError, ManualRefreshService } from "../services/manual-refresh-service";
import { requireAdmin } from "./auth-guard";

/**
 * 接收管理员发起的手动刷新请求。端点仅写入单行队列，不等待外部商店响应，
 * 这样浏览器断开不会中止后续统一采集；真正执行由调度器消费 queued 状态。
 */
export async function handleManualRefreshRoute(request: Request, database: D1Database): Promise<Response | null> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/refresh") return null;
  if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });

  try {
    const result = await new ManualRefreshService(new ManualRefreshRepository(database)).queue(new Date().toISOString());
    // 202 清楚表达请求已排队而非声称已经抓到价格；前端应以仪表盘的下一次采集状态确认完成。
    return Response.json({ status: "queued", requestedAt: result.requestedAt, nextAllowedAt: result.nextAllowedAt }, { status: 202 });
  } catch (error) {
    if (error instanceof ManualRefreshCooldownError) {
      return Response.json({ code: "REFRESH_COOLDOWN", error: error.message, nextAllowedAt: error.nextAllowedAt }, { status: 429 });
    }
    // 队列异常不回传 D1 细节，避免泄露表结构或运行时堆栈给已登录浏览器脚本和日志采集器。
    return Response.json({ code: "INTERNAL_ERROR", error: "刷新请求暂时无法提交，请稍后重试。" }, { status: 500 });
  }
}
