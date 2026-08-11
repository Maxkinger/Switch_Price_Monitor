import type { ProductType } from "../providers/types";
import type { AiProviderConfigurationReader } from "./ai-provider-configuration-service";

/**
 * 发送给 AI 的候选只保留已由官方发现流程确认的公开身份字段；candidateKey 仅用于本次 UI 结果关联，
 * 不能替代游戏 ID、订阅 ID 或数据库身份，从而避免把会话、价格和持久化数据交给外部供应商。
 */
export interface AiGameNameCandidate {
  candidateKey: string;
  canonicalTitle: string;
  publisher: string | null;
  productType: ProductType;
}

/** AI 输出经服务端收窄后的唯一结果形态；low 表示不可安全预填，displayNameZhCn 必须同时为 null。 */
export interface AiGameNameSuggestion {
  candidateKey: string;
  displayNameZhCn: string | null;
  confidence: "high" | "medium" | "low";
}

/**
 * 调用方只可见稳定的业务可用性提示，不承载网络异常、供应商正文或认证材料，
 * 防止错误响应和普通日志将 DeepSeek Key、代理细节或模型返回内容泄漏给管理员页面。
 */
export class AiGameNameSuggestionError extends Error {}

/**
 * 区分“管理员尚未配置、已删除或密文不可解”与已配置后的供应商故障。路由据此返回固定 AI_NOT_CONFIGURED，
 * 既帮助管理员进入设置页修复，又不暴露主密钥、密文状态或数据库失败原因。
 */
export class AiProviderNotConfiguredError extends Error {}

const DEEPSEEK_CHAT_COMPLETIONS_PATH = "/chat/completions";
const REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_CANDIDATES = 10;
const MAXIMUM_DISPLAY_NAME_LENGTH = 120;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * DeepSeek Chat Completions 的最小适配器。它不保存、不记录结果或秘密，并在模型内容不满足中文名称业务边界时
 * 返回与原候选一一对应的 null，确保管理员始终可以继续已有的手工确认流程。
 */
export class DeepSeekGameNameSuggestionService {
  public constructor(
    private readonly configuration: AiProviderConfigurationReader,
    private readonly request: typeof fetch = fetch,
  ) {}

  /**
   * 路由在解析管理员草稿前使用此只读状态做固定 503；随后 suggest 仍会再次读取，
   * 因而清除与外发之间的竞态最多降级为未配置，绝不会继续使用旧 Key。
   */
  public async isConfigured(): Promise<boolean> {
    return (await this.configuration.getCredentials()) !== null;
  }

  /**
   * 为一批 1..10 个官方候选生成建议。输入边界先于网络调用校验，限制提示词成本与 10 秒超时占用；
   * 网络或非成功 HTTP 只抛固定可用性错误，而模型 JSON 内容错误安全降级为可手工填写的低置信度空建议。
   */
  public async suggest(candidates: AiGameNameCandidate[]): Promise<AiGameNameSuggestion[]> {
    // 先判断配置状态，使已认证管理员在配置刚删除后即使提交陈旧/空草稿也得到统一的可恢复 503，且不会解析正文或外发。
    const credentials = await this.configuration.getCredentials();
    if (credentials === null) throw new AiProviderNotConfiguredError("AI 名称建议尚未配置。");
    if (candidates.length === 0 || candidates.length > MAXIMUM_CANDIDATES) {
      throw new AiGameNameSuggestionError("AI 名称建议候选数量无效。");
    }

    let response: Response;
    try {
      response = await this.request(`${credentials.apiBaseUrl}${DEEPSEEK_CHAT_COMPLETIONS_PATH}`, {
        method: "POST",
        // 不跟随供应商返回的重定向，确保携带 Key 的 Authorization 只用于代码中固定的 DeepSeek HTTPS 地址。
        redirect: "error",
        headers: {
          "content-type": "application/json",
          // 固定 HTTPS origin 是 Key 唯一的发送目标；请求 URL 不接受调用方输入，避免凭据被重定向到任意地址。
          authorization: `Bearer ${credentials.apiKey}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: credentials.model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              // 固定提示词把置信度限定为“常用本体译名与明确商品后缀能否组合使用”，而非是否能取得官方来源证明；
              // 结果只是管理员确认前的草稿，故已知本体和后缀不得因缺少外部佐证降级，同时仍须保留版本与商品类型以免误导商品身份。
              content: "你是任天堂商品的简体中文名称建议器。对每个候选先识别 canonicalTitle 中的游戏本体，并使用其常用简体中文译名；再组合版本和商品后缀，不能删除版本信息或改变商品类型。Nintendo Switch 2 Edition 原样保留；Upgrade Pack 译为“升级包”；DLC、季票、合集等使用常用简体中文商品表达。缺少官方来源证明不能作为 low 或 null 的理由，因为结果只供管理员确认。本体译名已知且后缀明确时 confidence 为 high；合理译名存在差异时为 medium；只有本体确实无法可靠识别或翻译时才返回 displayNameZhCn:null 与 confidence:\"low\"。示例：DAVE THE DIVER Nintendo Switch 2 Edition → 潜水员戴夫 Nintendo Switch 2 Edition；Overcooked! 2 - Nintendo Switch 2 Edition Upgrade Pack → 胡闹厨房！2 - Nintendo Switch 2 Edition 升级包。只返回 JSON 对象，成功格式示例为 {\"suggestions\":[{\"candidateKey\":\"原输入键\",\"displayNameZhCn\":\"中文名称\",\"confidence\":\"high\"}]}；无法识别时 displayNameZhCn 必须为 JSON null 且 confidence 必须为 \"low\"；confidence 只允许 \"high\"、\"medium\"、\"low\"。不得添加解释、来源、Markdown、编造事实或输入之外的候选键。",
            },
            {
              role: "user",
              // 逐项重建公开白名单，阻断运行时对象夹带的会话、价格、地区或任何其他字段。
              content: JSON.stringify({ candidates: candidates.map((candidate) => ({
                candidateKey: candidate.candidateKey,
                canonicalTitle: candidate.canonicalTitle,
                publisher: candidate.publisher,
                productType: candidate.productType,
              })) }),
            },
          ],
        }),
      });
    } catch {
      throw new AiGameNameSuggestionError("AI 名称建议暂时不可用。");
    }

    if (!response.ok) throw new AiGameNameSuggestionError("AI 名称建议暂时不可用。");

    let content: unknown;
    try {
      const payload = await response.json() as unknown;
      content = readMessageContent(payload);
    } catch {
      return unavailableSuggestions(candidates);
    }
    if (typeof content !== "string") return unavailableSuggestions(candidates);

    try {
      return normalizeSuggestions(candidates, JSON.parse(content) as unknown);
    } catch {
      return unavailableSuggestions(candidates);
    }
  }
}

/** 从供应商外层 JSON 中仅提取第一条 assistant 文本；任何额外字段、正文或诊断均不保留。 */
function readMessageContent(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) return undefined;
  const first = value.choices[0];
  return isRecord(first) && isRecord(first.message) ? first.message.content : undefined;
}

/**
 * 模型可返回数组，或因 JSON object 模式返回含 suggestions 数组的对象；两种形态都必须逐项重建。
 * 已知键出现重复时该键整体失效；重复次数必须在其他字段有效性之前统计，使“畸形一条、有效一条”也不能绕过唯一性。
 * 未知键不会占用任一输入候选，缺失或字段畸形的结果统一降级为 low/null。
 */
function normalizeSuggestions(candidates: AiGameNameCandidate[], value: unknown): AiGameNameSuggestion[] {
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.suggestions) ? value.suggestions : null;
  if (entries === null) return unavailableSuggestions(candidates);
  const candidateKeys = new Set(candidates.map((candidate) => candidate.candidateKey));
  const suggestions = new Map<string, AiGameNameSuggestion>();
  const candidateKeyCounts = new Map<string, number>();

  for (const entry of entries) {
    // 这里只读取字符串键并统计，不要求名称或置信度有效；任何输入键重复出现都必须整体失效。
    if (!isRecord(entry) || typeof entry.candidateKey !== "string" || !candidateKeys.has(entry.candidateKey)) continue;
    candidateKeyCounts.set(entry.candidateKey, (candidateKeyCounts.get(entry.candidateKey) ?? 0) + 1);
  }

  for (const entry of entries) {
    const suggestion = readSuggestion(entry);
    if (suggestion === null || !candidateKeys.has(suggestion.candidateKey)) continue;
    suggestions.set(suggestion.candidateKey, suggestion);
  }

  return candidates.map((candidate) => {
    const suggestion = suggestions.get(candidate.candidateKey);
    if ((candidateKeyCounts.get(candidate.candidateKey) ?? 0) !== 1 || suggestion === undefined || suggestion.confidence === "low" || suggestion.displayNameZhCn === null) {
      return unavailableSuggestion(candidate.candidateKey);
    }
    return suggestion;
  });
}

/** 单条名称只接受三字段、受控置信度和无控制字符的修剪后 1..120 字符文本；否则不让原始模型对象穿透。 */
function readSuggestion(value: unknown): AiGameNameSuggestion | null {
  if (!isRecord(value) || typeof value.candidateKey !== "string" || !isConfidence(value.confidence)) return null;
  if (value.displayNameZhCn === null) return { candidateKey: value.candidateKey, displayNameZhCn: null, confidence: value.confidence };
  if (typeof value.displayNameZhCn !== "string") return null;
  const displayNameZhCn = value.displayNameZhCn.trim();
  if (displayNameZhCn.length === 0 || displayNameZhCn.length > MAXIMUM_DISPLAY_NAME_LENGTH || CONTROL_CHARACTER.test(displayNameZhCn)) return null;
  return { candidateKey: value.candidateKey, displayNameZhCn, confidence: value.confidence };
}

/** 置信度只允许产品合同的三个固定等级，未知文本不能以类型断言伪装为可预填建议。 */
function isConfidence(value: unknown): value is AiGameNameSuggestion["confidence"] {
  return value === "high" || value === "medium" || value === "low";
}

/** JSON 边界仅接受普通对象，拒绝数组、null 和原型无关的动态值。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 所有不可安全使用的模型结果都保留原输入顺序和关联键，供浏览器保持每个草稿隔离。 */
function unavailableSuggestions(candidates: AiGameNameCandidate[]): AiGameNameSuggestion[] {
  return candidates.map((candidate) => unavailableSuggestion(candidate.candidateKey));
}

/** low/null 是唯一安全的降级表示，不能将模型错误文本作为用户可见名称。 */
function unavailableSuggestion(candidateKey: string): AiGameNameSuggestion {
  return { candidateKey, displayNameZhCn: null, confidence: "low" };
}
