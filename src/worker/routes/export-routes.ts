import { ExportService } from "../services/export-service";
import { requireAdmin } from "./auth-guard";

/** 导出接口由管理员会话保护，且只接受明确白名单 kind，不能让请求参数选择表名或列名。 */
export async function handleExportRoute(request: Request, database: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/export") return null;
  if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  const service = new ExportService(database);
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
