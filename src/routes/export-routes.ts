import type { SessionReader } from "../services/auth-service";
import type { ExportService } from "../services/export-service";
import { requireAdmin } from "./auth-guard";

/** CSV 路由只接收固定用途导出服务；请求参数不能选择表名、列名或数据库实现。 */
export interface ExportRouteDependencies {
  sessions: SessionReader;
  exports: Pick<ExportService, "pricesCsv" | "subscriptionsCsv" | "fetchLogsCsv">;
}

/** 导出接口由管理员会话保护，且只接受明确白名单 kind，不能让请求参数选择表名或列名。 */
export async function handleExportRoute(request: Request, dependencies: ExportRouteDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/export") return null;
  if (!(await requireAdmin(request, dependencies.sessions))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  const service = dependencies.exports;
  const kind = url.searchParams.get("kind");
  const exportResult = kind === "prices"
    ? { content: await service.pricesCsv(), filename: "switch-price-history.csv" }
    : kind === "subscriptions"
      ? { content: await service.subscriptionsCsv(), filename: "switch-subscriptions.csv" }
      : kind === "fetch-logs"
        ? { content: await service.fetchLogsCsv(), filename: "switch-fetch-logs.csv" }
        : null;
  if (!exportResult) return Response.json({ code: "VALIDATION_ERROR", error: "导出类型无效。" }, { status: 422 });
  return new Response(exportResult.content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${exportResult.filename}"` } });
}
