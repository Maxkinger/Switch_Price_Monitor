import { ExportService } from "../services/export-service";
import { requireAdmin } from "./auth-guard";

/** 导出接口由管理员会话保护，且只接受明确白名单 kind，不能让请求参数选择表名或列名。 */
export async function handleExportRoute(request: Request, database: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/api/export") return null;
  if (!(await requireAdmin(request, database))) return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
  if (url.searchParams.get("kind") !== "prices") return Response.json({ code: "VALIDATION_ERROR", error: "导出类型无效。" }, { status: 422 });
  return new Response(await new ExportService(database).pricesCsv(), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="switch-price-history.csv"' } });
}
