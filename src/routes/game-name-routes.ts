import type { ProductType } from "../providers/types";
import type { PendingGameName } from "../repositories/ports";
import {
  GameNameNotFoundError,
  GameNameService,
  GameNameValidationError,
  type SaveManualGameNameInput,
} from "../services/game-name-service";
import {
  AiProviderNotConfiguredError,
  AiGameNameSuggestionError,
  type DeepSeekGameNameSuggestionService,
} from "../services/deepseek-game-name-suggestion-service";
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

/**
 * AI 路由只依赖 Task 1 服务公开的 suggest 能力，不取得 Key、模型、fetch 或名称仓储；
 * 这个窄接口保证同源 HTTP 层只能转发已收窄的公开候选，不能借 AI 建议触发持久化或泄漏供应商认证材料。
 */
type GameNameAiSuggestionService = Pick<DeepSeekGameNameSuggestionService, "suggest"> & Partial<Pick<DeepSeekGameNameSuggestionService, "isConfigured">>;

type GameNameAction =
  | { kind: "list" }
  | { kind: "backfill" }
  | { kind: "suggestions" }
  | { kind: "ai-suggestions" }
  | { kind: "save"; gameId: string };

const gameNameSources = ["publisher", "mainland-platform", "hk-reference", "manual"] as const;
const productTypes: readonly ProductType[] = ["game", "upgrade-pack", "dlc", "season-pass", "bundle", "other"];
const MAXIMUM_AI_CANDIDATES = 10;
const MAXIMUM_AI_CANDIDATE_KEY_LENGTH = 64;
const MAXIMUM_UI_CANDIDATE_KEY_LENGTH = 2_048;
const MAXIMUM_OFFICIAL_TITLE_LENGTH = 200;
const MAXIMUM_PUBLISHER_LENGTH = 120;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * 受认证的名称管理入口只匹配五条精确 API 合同，并在认证通过后才解析管理员 JSON 或访问存储。
 * 两类建议端点只读：目录建议只查询已确认词条，AI 建议仅发送公开候选给可选服务；最终订阅创建仍重新验证官方身份，浏览器候选绝不形成持久化身份。
 */
export async function handleGameNameRoute(
  request: Request,
  sessions: SessionReader,
  service: GameNameRouteService,
  localDevelopmentAuthBypass = false,
  aiSuggestions: GameNameAiSuggestionService | null = null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const action = readAction(request.method, url.pathname);
  if (action === null) return null;

  try {
    /**
     * 正式运行始终同时经过共享守卫和真实 Cookie/Session 校验：回填会修改多个游戏，人工保存还可建立未来复用词条。
     * 唯一例外是启动配置已显式开启的本机开发旁路；进程入口会把该模式强制绑定到 127.0.0.1，因而不能由请求、Cookie 或浏览器地址伪造为局域网匿名写入。
     */
    if (!(await requireAdmin(request, sessions)) || (!localDevelopmentAuthBypass && !(await requireGameNameAdmin(request, sessions)))) {
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
    if (action.kind === "ai-suggestions") {
      /**
       * 未配置 Key 时不解析正文、更不创建外部客户端；固定 503 让已认证管理员知晓可选能力不可用，
       * 同时避免响应泄漏 Key 是否为空白、模型配置或供应商网络细节。认证已在此前完成，匿名请求仍固定 401。
       */
      if (aiSuggestions === null || aiSuggestions.isConfigured !== undefined && !(await aiSuggestions.isConfigured())) {
        return Response.json({ code: "AI_NOT_CONFIGURED", error: "AI 名称建议尚未配置。" }, { status: 503 });
      }
      // AI 专用收窄只允许短批内键、标题、发行商与类型，绝无 URL、价格、会话或其他运行时字段。
      return Response.json({ suggestions: await aiSuggestions.suggest(readAiSuggestionCandidates(await readJson(request))) });
    }

    const input = readManualInput(await readJson(request));
    // 单游戏写入可能同时建立未来复用词条，严格认证和字段收窄必须先于任何数据库事务。
    await service.saveManual(action.gameId, input, new Date().toISOString());
    /** 当前游戏始终是管理员针对该记录的 manual 最终覆盖；source 输入只用于可选目录词条的公开证据审计。 */
    return Response.json({ gameId: action.gameId, displayNameZhCn: input.displayNameZhCn.trim(), source: "manual" });
  } catch (error) {
    const notFound = error instanceof GameNameNotFoundError;
    const validation = error instanceof GameNameRequestError || error instanceof GameNameValidationError;
    const aiNotConfigured = error instanceof AiProviderNotConfiguredError;
    const aiUnavailable = error instanceof AiGameNameSuggestionError;
    return Response.json({
      code: notFound ? "NOT_FOUND" : validation ? "VALIDATION_ERROR" : aiNotConfigured ? "AI_NOT_CONFIGURED" : aiUnavailable ? "AI_UNAVAILABLE" : "INTERNAL_ERROR",
      // 只有已分类的领域/请求错误可向管理员显示；SQL、数据库 URL、外部网页、堆栈和未知 message 一律替换。
      error: notFound || validation
        ? error.message
        : aiNotConfigured
          ? "AI 名称建议尚未配置。"
          : aiUnavailable
          ? "AI 名称建议暂时不可用。"
          : "游戏名称暂时无法处理，请稍后重试。",
    }, { status: notFound ? 404 : validation ? 422 : aiNotConfigured || aiUnavailable ? 503 : 500 });
  }
}

/**
 * 名称管理专属严格守卫只提取精确 session Cookie，并始终调用注入的真实会话读取器。
 * 空 Cookie 直接拒绝，既避免无意义摘要查询，也保证正式、NAS 与未开启本机旁路的进程不能由空请求取得名称写权限。
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
  if (method === "POST" && pathname === "/api/game-names/ai-suggestions") return { kind: "ai-suggestions" };
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
function readSuggestionCandidates(value: unknown, maximumCandidateKeyLength = MAXIMUM_UI_CANDIDATE_KEY_LENGTH): NameSuggestionCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new GameNameRequestError("名称建议请求无效。");
  }
  const candidates = value.candidates.map((candidate) => readSuggestionCandidate(candidate, maximumCandidateKeyLength));
  if (new Set(candidates.map((candidate) => candidate.candidateKey)).size !== candidates.length) {
    throw new GameNameRequestError("名称建议候选标识不能重复。");
  }
  return candidates;
}

/**
 * AI 外部调用只接受 1..10 项；数量在路由边界先于适配器和网络校验，确保非法管理员请求稳定返回 422，
 * 而适配器抛出的同名领域错误只表示已经配置后的网络、超时或供应商不可用状态。
 */
function readAiSuggestionCandidates(value: unknown): NameSuggestionCandidate[] {
  const candidates = readSuggestionCandidates(value, MAXIMUM_AI_CANDIDATE_KEY_LENGTH);
  if (candidates.length < 1 || candidates.length > MAXIMUM_AI_CANDIDATES) {
    throw new GameNameRequestError("AI 名称建议候选数量应为 1 到 10 项。");
  }
  return candidates;
}

/**
 * 标题、发行商与类型必须完整，才能计算与 PostgreSQL normalized_name 相同的精确键；candidateKey 仅用于返回顺序关联。
 * AI 批内键限制为 64 字符；同源目录建议保留既有 `region:productUrl` UI 键但限制为 2048 字符，绝不会发给外部模型。
 * 官方标题允许至 200 字符以容纳版本后缀，发行商与现有中文名称合同同为 120 字符；
 * 三类文本都拒绝 C0/C1 控制字符，避免放大提示词、日志注入或让不可见差异破坏精确身份关联。
 */
function readSuggestionCandidate(value: unknown, maximumCandidateKeyLength: number): NameSuggestionCandidate {
  if (!isRecord(value)) throw new GameNameRequestError("名称建议候选无效。");
  return {
    candidateKey: readBoundedText(value.candidateKey, maximumCandidateKeyLength, "名称建议候选标识无效。"),
    canonicalTitle: readBoundedText(value.canonicalTitle, MAXIMUM_OFFICIAL_TITLE_LENGTH, "名称建议官方标题无效。"),
    publisher: value.publisher === null ? null : readBoundedText(value.publisher, MAXIMUM_PUBLISHER_LENGTH, "名称建议发行商无效。"),
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

/** 建议字段按修剪后的领域上限收窄并拒绝全部 C0/C1 控制字符；返回修剪文本，使身份计算与外部 prompt 不携带无意义边缘空白。 */
function readBoundedText(value: unknown, maximumLength: number, message: string): string {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) throw new GameNameRequestError(message);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximumLength) throw new GameNameRequestError(message);
  return normalized;
}

/** 路由专属输入错误只用于不可信 JSON 与查询参数，不能包装数据库或外部提供方异常。 */
class GameNameRequestError extends Error {}
