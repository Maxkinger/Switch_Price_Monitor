import type { ProductType } from "../providers/types";
import type { PendingGameName } from "../repositories/ports";
import {
  GameNameNotFoundError,
  GameNameService,
  GameNameValidationError,
  type SaveManualGameNameInput,
} from "../services/game-name-service";
import { gameNameIdentityKey } from "../shared/game-name-identity";
import { requireAdmin, type SessionReader } from "./auth-guard";

/** 向导提交的名称建议候选只保留前端关联键与官方公开身份字段；中文名称、游戏 ID 和订阅 ID 都不能参与目录身份。 */
export interface NameSuggestionCandidate {
  candidateKey: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/** 每个建议与浏览器候选键一一对应；null 明确表示没有已确认词条，不能被前端解释成允许创建新身份。 */
export interface NameSuggestion {
  candidateKey: string;
  displayNameZhCn: string | null;
}

type GameNameRouteService = Pick<
  GameNameService,
  "listPending" | "backfill" | "resolveForConfirmedGame" | "saveManual"
>;

type GameNameAction =
  | { kind: "list" }
  | { kind: "backfill" }
  | { kind: "suggestions" }
  | { kind: "save"; gameId: string };

const gameNameSources = ["publisher", "mainland-platform", "hk-reference", "manual"] as const;
const productTypes: readonly ProductType[] = ["game", "upgrade-pack", "dlc", "season-pass", "bundle", "other"];

/**
 * 受认证的名称管理入口只匹配四条精确 API 合同，并在认证通过后才解析管理员 JSON 或访问存储。
 * 建议端点只读取已确认目录作为 UI 预填；最终订阅创建仍由确认服务重新验证官方身份，浏览器候选绝不形成持久化身份。
 */
export async function handleGameNameRoute(
  request: Request,
  sessions: SessionReader,
  service: GameNameRouteService,
): Promise<Response | null> {
  const url = new URL(request.url);
  const action = readAction(request.method, url.pathname);
  if (action === null) return null;

  try {
    /**
     * 共享 requireAdmin 当前保留项目级本机开发旁路；名称管理另做真实 Cookie/Session 校验。
     * 批量回填会修改多个游戏，人工名称还可能写入未来复用目录，均属高影响操作，不能继承其他开发期路由的匿名直入。
     */
    if (!(await requireAdmin(request, sessions)) || !(await requireGameNameAdmin(request, sessions))) {
      return Response.json({ code: "UNAUTHORIZED", error: "请先登录。" }, { status: 401 });
    }
    if (action.kind === "list") {
      validatePendingFilter(url);
      return Response.json({ games: await service.listPending() satisfies PendingGameName[] });
    }
    if (action.kind === "backfill") {
      // 批量回填只在严格会话校验后执行；服务/仓储仍只更新目录精确命中的空名称，绝不覆盖人工确认结果。
      return Response.json(await service.backfill(new Date().toISOString()));
    }
    if (action.kind === "suggestions") {
      const candidates = readSuggestionCandidates(await readJson(request));
      const suggestions = await Promise.all(candidates.map(async (candidate): Promise<NameSuggestion> => {
        /**
         * candidateKey 只回传给 UI 做结果关联，目录查询键必须由三个官方身份字段重新计算。
         * resolveForConfirmedGame 的 null 候选保证未命中时只返回 pending，而不会把浏览器文本保存成 manual。
         */
        const resolved = await service.resolveForConfirmedGame(gameNameIdentityKey(candidate), null);
        return {
          candidateKey: candidate.candidateKey,
          displayNameZhCn: resolved.source === "catalog" ? resolved.displayNameZhCn : null,
        };
      }));
      return Response.json({ suggestions });
    }

    const input = readManualInput(await readJson(request));
    // 单游戏写入可能同时建立未来复用词条，严格认证和字段收窄必须先于任何数据库事务。
    await service.saveManual(action.gameId, input, new Date().toISOString());
    /** 当前游戏始终是管理员针对该记录的 manual 最终覆盖；source 输入只用于可选目录词条的公开证据审计。 */
    return Response.json({ gameId: action.gameId, displayNameZhCn: input.displayNameZhCn.trim(), source: "manual" });
  } catch (error) {
    const notFound = error instanceof GameNameNotFoundError;
    const validation = error instanceof GameNameRequestError || error instanceof GameNameValidationError;
    return Response.json({
      code: notFound ? "NOT_FOUND" : validation ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
      // 只有已分类的领域/请求错误可向管理员显示；SQL、数据库 URL、外部网页、堆栈和未知 message 一律替换。
      error: notFound || validation
        ? error.message
        : "游戏名称暂时无法处理，请稍后重试。",
    }, { status: notFound ? 404 : validation ? 422 : 500 });
  }
}

/**
 * 名称管理专属严格守卫只提取精确 session Cookie，并始终调用注入的真实会话读取器。
 * 空 Cookie 直接拒绝，既避免无意义摘要查询，也防止 localDevelopmentAuthBypass 的“任意 token 为真”语义被这组高影响端点继承。
 */
async function requireGameNameAdmin(request: Request, sessions: SessionReader): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie");
  const token = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("session="))
    ?.slice("session=".length) ?? "";
  if (token.length === 0) return false;
  return sessions.authenticate(token, new Date().toISOString());
}

/** 路径匹配不使用 startsWith；未知方法、额外子路径或空 gameId 必须交还 dispatcher 生成统一 404。 */
function readAction(method: string, pathname: string): GameNameAction | null {
  if (method === "GET" && pathname === "/api/game-names") return { kind: "list" };
  if (method === "POST" && pathname === "/api/game-names/backfill") return { kind: "backfill" };
  if (method === "POST" && pathname === "/api/game-names/suggestions") return { kind: "suggestions" };
  const match = method === "PATCH" ? pathname.match(/^\/api\/game-names\/([^/]+)$/u) : null;
  if (!match) return null;
  try {
    const gameId = decodeURIComponent(match[1]);
    return gameId.trim().length === 0 || gameId.includes("/") ? null : { kind: "save", gameId };
  } catch {
    return null;
  }
}

/** 列表首版只允许一个 pending 筛选值，避免无声忽略未知查询导致管理员误以为看到了其他状态全集。 */
function validatePendingFilter(url: URL): void {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "status" || url.searchParams.getAll("status").length !== 1 || url.searchParams.get("status") !== "pending") {
    throw new GameNameRequestError("名称状态筛选无效。");
  }
}

/** Fetch JSON 语法错误属于可修正请求问题；固定文案不会回显原始正文或解析器位置。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json() as unknown;
  } catch {
    throw new GameNameRequestError("请求内容必须是有效 JSON 对象。");
  }
}

/** 建议载荷只接受普通顶层对象与候选数组；数组元素逐字段重建，未知浏览器字段不会穿透服务边界。 */
function readSuggestionCandidates(value: unknown): NameSuggestionCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new GameNameRequestError("名称建议请求无效。");
  }
  return value.candidates.map((candidate) => readSuggestionCandidate(candidate));
}

/** 标题、发行商与类型必须完整，才能计算与 PostgreSQL normalized_name 相同的精确键；candidateKey 仅用于返回顺序关联。 */
function readSuggestionCandidate(value: unknown): NameSuggestionCandidate {
  if (!isRecord(value)) throw new GameNameRequestError("名称建议候选无效。");
  return {
    candidateKey: readNonEmptyString(value.candidateKey, "名称建议候选标识无效。"),
    canonicalTitle: readNonEmptyString(value.canonicalTitle, "名称建议官方标题无效。"),
    publisher: value.publisher === null ? null : readNonEmptyString(value.publisher, "名称建议发行商无效。"),
    productType: readProductType(value.productType),
  };
}

/**
 * 人工保存命令严格重建 Task 2 的四字段并拒绝未知形态；名称上界与迁移 CHECK 一致，
 * 可复用的非 manual 来源还必须带 HTTPS 证据，避免无出处词条被未来游戏自动回填。
 */
function readManualInput(value: unknown): SaveManualGameNameInput {
  if (!isRecord(value)) throw new GameNameRequestError("请求内容必须是对象。");
  const displayNameZhCn = readDisplayName(value.displayNameZhCn);
  const source = readSource(value.source);
  const evidenceUrl = readEvidenceUrl(value.evidenceUrl);
  if (typeof value.saveToCatalog !== "boolean") throw new GameNameRequestError("名称词条复用设置无效。");
  if (source !== "manual" && evidenceUrl === null) {
    throw new GameNameRequestError("非人工名称来源必须提供 HTTPS 证据链接。");
  }
  return { displayNameZhCn, source, evidenceUrl, saveToCatalog: value.saveToCatalog };
}

/** 中文显示名修剪后必须是 1..120 字符；路由提前返回稳定 422，数据库 CHECK 仍作为最终一致性保护。 */
function readDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new GameNameRequestError("中文显示名称长度应为 1 到 120 个字符。");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new GameNameRequestError("中文显示名称长度应为 1 到 120 个字符。");
  }
  return normalized;
}

/** 来源只允许迁移 CHECK 与领域端口共享的四个审计枚举，未知文本不能进入 SQL 参数或前端来源标签。 */
function readSource(value: unknown): SaveManualGameNameInput["source"] {
  if (typeof value !== "string" || !gameNameSources.includes(value as SaveManualGameNameInput["source"])) {
    throw new GameNameRequestError("中文名称来源无效。");
  }
  return value as SaveManualGameNameInput["source"];
}

/** null 表示 manual 可以没有公开证据；非空证据只允许 HTTPS，禁止脚本、本地路径和明文 HTTP 进入审计链接。 */
function readEvidenceUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new GameNameRequestError("名称证据链接必须使用 HTTPS。");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new GameNameRequestError("名称证据链接必须使用 HTTPS。");
    return url.toString();
  } catch (error) {
    if (error instanceof GameNameRequestError) throw error;
    throw new GameNameRequestError("名称证据链接必须使用 HTTPS。");
  }
}

/** 商品类型必须属于官方发现与持久化共用枚举，防止同标题本体、DLC 或升级包共享错误建议。 */
function readProductType(value: unknown): ProductType {
  if (typeof value !== "string" || !productTypes.includes(value as ProductType)) {
    throw new GameNameRequestError("名称建议商品类型无效。");
  }
  return value as ProductType;
}

/** JSON 边界仅接受非 null、非数组对象；字段会在专用读取器中逐项重建，不信任动态值的 TypeScript 断言。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 浏览器关联键和官方身份文本拒绝空白，但保留原值供精确规范化或 UI 关联，绝不进行翻译或模糊别名替换。 */
function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new GameNameRequestError(message);
  return value;
}

/** 路由专属输入错误只用于不可信 JSON 与查询参数，不能包装数据库或外部提供方异常。 */
class GameNameRequestError extends Error {}
