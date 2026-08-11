import { useMemo, useRef, useState, type FormEvent } from "react";
import { createProductApiClient, ProductApiError, type RegionResolutionResponse } from "./api-client";
import { GameNameApiError, type AiGameNameSuggestion, type GameNameSuggestionCandidate } from "./game-name-api-client";
import {
  candidatePriceLabel,
  applyAutomaticRegionResolutions,
  canConfirmChineseNames,
  canConfirmConfiguredRegions,
  createSubscriptionWizardState,
  hasNoOfficialCandidates,
  regionalConfirmationKey,
  setRegionalCandidate,
  setChineseNameDraft,
  skipRegionalConfirmation,
  selectCandidate,
  type CandidatePriceLabel,
  type SubscriptionWizardState,
} from "./subscription-wizard";
import type {
  ConfirmedRegionalProduct,
  ConfirmedSubscriptionInput,
  OfficialProductCandidate,
  OfficialSearchResult,
  RegionCode,
  RegionalProductMatchSource,
  SubscriptionConfirmationResult,
} from "../shared/domain";

/** 向导仅需要已确认词条的建议读取能力；不能取得管理页的回填或人工保存权限，减少页面可发起的写操作范围。 */
interface GameNameSuggestionApi {
  suggestNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: Array<{ candidateKey: string; displayNameZhCn: string | null }> }>;
  suggestAiNames(candidates: GameNameSuggestionCandidate[]): Promise<{ suggestions: AiGameNameSuggestion[] }>;
}

/**
 * 地区标签仅用于 UI 文案与官方链接回退选择，绝不代表跨区业务范围。
 * 实际启用地区由 Node 服务保存设置决定，向导不会把此展示常量发送给跨区解析接口。
 */
const regionChoices: ReadonlyArray<{ code: RegionCode; name: string }> = [
  { code: "US", name: "美区" },
  { code: "JP", name: "日区" },
  { code: "MX", name: "墨西哥区" },
  { code: "BR", name: "巴西区" },
  { code: "HK", name: "香港区" },
];

/** 空结果使初次进入页面不虚构商品数据，并保留与服务端一致的可用状态。 */
const emptySearchResult: OfficialSearchResult = { status: "available", candidates: [] };

/** 用地区和已验证官方 URL 组成瞬时 UI 键；不能用可本地化的标题作为多选身份。 */
function candidateKey(candidate: Pick<OfficialProductCandidate, "regionCode" | "productUrl">): string {
  return `${candidate.regionCode}:${candidate.productUrl}`;
}

/** 将最小货币单位格式化为当地货币。任天堂价格返回的金额不可在浏览器直接转换为人民币，汇率逻辑留在快照服务。 */
function formatLocalPrice(amountMinor: number, currency: string): string {
  const decimalPlaces = currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(amountMinor / 10 ** decimalPlaces);
}

/** 从地区解析返回的状态中提取稳定文案；外部抓取错误不会直接进入页面。 */
function resolutionLabel(resolution: RegionResolutionResponse): string {
  if (resolution.status === "automatic") return "已自动匹配官方商品";
  if (resolution.status === "needs-manual-selection") return "请选择该区官方候选商品";
  return "请粘贴该区任天堂官方商品链接";
}

/**
 * 单个官方候选商品卡。整张卡是单选按钮，避免“选择”按钮与卡片点击产生两套不一致的状态；
 * 图片仅使用服务端返回的公开封面 URL，缺图时保留固定占位，不影响名称、类型和价格核对。
 */
function CandidateCard({
  candidate,
  selected,
  onToggle,
}: {
  candidate: OfficialProductCandidate;
  selected: boolean;
  onToggle: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const price = candidatePriceLabel(candidate);

  return (
    <button
      className={`candidate-card${selected ? " candidate-card--selected" : ""}`}
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
    >
      <div className="candidate-card__cover" aria-hidden="true">
        {candidate.coverUrl && !imageFailed ? (
          <img src={candidate.coverUrl} alt="" onError={() => setImageFailed(true)} />
        ) : (
          <span>无封面</span>
        )}
      </div>
      <div className="candidate-card__content">
        <strong className="candidate-card__title">{candidate.canonicalTitle}</strong>
        <span className="candidate-card__type">{candidate.productType}</span>
        <div className="candidate-card__footer">
          <span className="candidate-card__publisher">{candidate.publisher ?? "发行商待确认"}</span>
          <CandidatePrice price={price} currency={candidate.currency} />
        </div>
      </div>
    </button>
  );
}

/** 候选卡右下角的价格布局：原价只在服务端确认的有效促销时划线显示。 */
function CandidatePrice({ price, currency }: { price: CandidatePriceLabel; currency: string }) {
  if (price.kind === "pending") return <span className="candidate-price candidate-price--pending">价格待确认</span>;
  if (price.kind === "current") return <span className="candidate-price">{formatLocalPrice(price.currentMinor, currency)}</span>;

  return (
    <span className="candidate-price candidate-price--sale">
      <del>{formatLocalPrice(price.regularMinor, currency)}</del>
      <b>{formatLocalPrice(price.currentMinor, currency)}</b>
      <em>-{price.discountPercent}%</em>
    </span>
  );
}

/**
 * 针对一款已选默认区商品的跨区确认面板。自动匹配也必须由管理员在最终提交前可见，
 * 手动链接只送到同源 Node API 验证，不能把用户输入直接作为地区商品或价格来源保存。
 */
function RegionalConfirmationPanel({
  selected,
  resolutions,
  confirmedCandidates,
  manualLinks,
  pendingLinkKey,
  isRegionalInteractionDisabled,
  expandedRegionalKeys,
  onSelectCandidate,
  onManualLinkChange,
  onResolveLink,
  onRetryRegions,
  onToggleSkip,
  onToggleCandidateExpansion,
}: {
  selected: OfficialProductCandidate;
  resolutions: RegionResolutionResponse[];
  confirmedCandidates: Record<string, OfficialProductCandidate>;
  manualLinks: Record<string, string>;
  pendingLinkKey: string | null;
  /** 搜索或地区解析进行中时禁止会发网的地区操作，避免旧面板在新搜索尚未结算时并发启动本地 Playwright 核验。 */
  isRegionalInteractionDisabled: boolean;
  /** 展开键只控制当前页面的候选可见性，不能参与地区确认、跳过或最终订阅载荷。 */
  expandedRegionalKeys: string[];
  onSelectCandidate: (regionCode: RegionCode, candidate: OfficialProductCandidate, source: RegionalProductMatchSource) => void;
  onManualLinkChange: (key: string, value: string) => void;
  onResolveLink: (regionCode: RegionCode) => void;
  /** 日区自动关系发现失败时由管理员显式再次触发；该点击不读取 effect，避免后台反复消耗本地 Chromium 资源。 */
  onRetryRegions: () => void;
  onToggleSkip: (regionCode: RegionCode) => void;
  onToggleCandidateExpansion: (key: string) => void;
}) {
  const selectedKey = candidateKey(selected);
  const otherRegions = resolutions.filter((resolution) => resolution.candidateKey === selectedKey);

  if (otherRegions.length === 0) return null;

  return (
    <section className="regional-panel">
      <div className="regional-panel__heading">
        <div>
          <p className="eyebrow">跨区核验</p>
          <h3>{selected.canonicalTitle}</h3>
        </div>
        <span>{otherRegions.length} 个待核验地区</span>
      </div>
      <div className="regional-panel__grid">
        {otherRegions.map((resolution) => {
          const key = regionalConfirmationKey(selectedKey, resolution.regionCode);
          const confirmed = confirmedCandidates[key];
          const isExpanded = expandedRegionalKeys.includes(key);
          // 服务端已按官方身份信号排序并给出首屏数量；前端只消费这个受控结果，不能自行按标题、价格或搜索顺序猜测商品关系。
          const visibleCandidates = resolution.status === "needs-manual-selection" && !isExpanded
            ? resolution.candidates.slice(0, resolution.featuredCandidateCount)
            : resolution.status === "needs-manual-selection" ? resolution.candidates : [];
          const hiddenCandidateCount = resolution.status === "needs-manual-selection"
            ? resolution.candidates.length - visibleCandidates.length
            : 0;
          return (
            <article className="regional-option" key={key}>
              <div>
                <span className="regional-option__region">{regionChoices.find((region) => region.code === resolution.regionCode)?.name}</span>
                <p>{resolutionLabel(resolution)}</p>
              </div>
              {resolution.status === "automatic" ? (
                <small className="regional-option__confirmed">已自动加入监控：{resolution.candidate.canonicalTitle}</small>
              ) : null}
              {resolution.status === "needs-manual-selection" ? (
                <div className="regional-option__candidates">
                  {visibleCandidates.map((candidate) => (
                    <CandidateCard
                      key={candidate.productUrl}
                      candidate={candidate}
                      selected={confirmed?.productUrl === candidate.productUrl}
                      onToggle={() => onSelectCandidate(resolution.regionCode, candidate, "manual_selection")}
                    />
                  ))}
                  {hiddenCandidateCount > 0 ? (
                    <button type="button" className="text-button regional-option__more-candidates" aria-expanded={isExpanded} onClick={() => onToggleCandidateExpansion(key)}>
                      {`显示更多官方候选（${hiddenCandidateCount}）`}
                    </button>
                  ) : null}
                  {isExpanded && resolution.candidates.length > resolution.featuredCandidateCount ? (
                    <button type="button" className="text-button regional-option__more-candidates" aria-expanded="true" onClick={() => onToggleCandidateExpansion(key)}>
                      收起更多官方候选
                    </button>
                  ) : null}
                </div>
              ) : null}
              {resolution.status === "needs-manual-link" ? (
                <div className="regional-option__link">
                  <p>{resolution.message}</p>
                  {resolution.regionCode === "JP" ? (
                    <button type="button" className="text-button" disabled={isRegionalInteractionDisabled} onClick={onRetryRegions}>重新核验</button>
                  ) : null}
                  <input
                    type="url"
                    value={manualLinks[key] ?? ""}
                    onChange={(event) => onManualLinkChange(key, event.target.value)}
                    placeholder="粘贴该区任天堂官方商品链接"
                    aria-label={`${resolution.regionCode} 任天堂官方商品链接`}
                  />
                  <button type="button" className="text-button" disabled={isRegionalInteractionDisabled || pendingLinkKey === key} onClick={() => onResolveLink(resolution.regionCode)}>
                    {pendingLinkKey === key ? "核验中…" : confirmed ? "重新核验" : "核验链接"}
                  </button>
                </div>
              ) : null}
              {confirmed ? <small className="regional-option__confirmed">已确认：{confirmed.canonicalTitle}</small> : null}
              <button type="button" className="text-button" onClick={() => onToggleSkip(resolution.regionCode)}>
                {confirmed ? "取消该区确认并跳过" : "跳过此区"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * 已认证后的添加订阅向导。它只管理本次选择过程，最终写入前由后端重新验证每个官方链接并原子化创建订阅；
 * 共享商品客户端由应用壳传入，使搜索、核验和确认都计入全局加载状态，且刷新、取消或认证失效不会留下部分数据。
 */
export function SubscriptionWizardPage({ api, gameNameApi, onUnauthorized }: { api: ReturnType<typeof createProductApiClient>; gameNameApi: GameNameSuggestionApi; onUnauthorized: () => void }) {
  const [wizard, setWizard] = useState<SubscriptionWizardState>(() => createSubscriptionWizardState(emptySearchResult));
  const [query, setQuery] = useState("");
  const [fallbackRegion, setFallbackRegion] = useState<RegionCode>("US");
  const [fallbackLink, setFallbackLink] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isResolvingRegions, setIsResolvingRegions] = useState(false);
  /**
   * AI 名称只在管理员成功完成地区核验后才读取；该局部状态不得禁用名称输入或地区操作，
   * 以便可选的外部建议失败、超时或迟到时，管理员仍能完成经官方链接核验的订阅。
   */
  const [isAiNameSuggestionLoading, setIsAiNameSuggestionLoading] = useState(false);
  /**
   * 每次跨区解析都持有递增代次。搜索、官方链接回退或下一次解析会使旧代次失效，
   * 这样慢速本地 Playwright 核验的成功、失败和 finally 都不能覆盖后来搜索的地区结果或加载状态。
   */
  const regionResolutionGeneration = useRef(0);
  /**
   * 手动地区链接与整批地区解析一样绑定到当前默认区候选；选择切换后递增代次，
   * 防止慢速官方链接校验把旧商品写进新商品的地区确认或错误关闭新请求的“核验中”状态。
   */
  const manualLinkResolutionGeneration = useRef(0);
  /**
   * 异步回调闭包中的 `selectedCandidates` 是发起时快照，不能代表管理员当前选择。
   * 该 ref 只保存当前唯一候选键，使核验返回前可同步确认商品身份未被切换或取消。
   */
  const currentSelectedCandidateKey = useRef<string | null>(null);
  /**
   * 名称建议代次统一保护目录与 AI 两种只读预填。候选切换、搜索和每次新的 AI 批次都会递增它，
   * 防止旧商品或旧核验的迟到结果覆盖当前草稿；此代次不包含 URL、游戏 ID 或任何可持久化身份。
   */
  const nameSuggestionGeneration = useRef(0);
  /**
   * AI 批次使用独立递增序号生成不含 URL 的瞬时关联键；序号只存在浏览器内存，
   * 既避免不同并发批次复用键，也不会把地区商品地址、游戏 ID 或订阅身份交给外部模型。
   */
  const aiSuggestionBatchSequence = useRef(0);
  /**
   * 价格来源预览也属于当前默认区候选的短暂 UI 状态。选择、取消、搜索或另一预览开始时都会使旧代次失效，
   * 因为旧商品的来源结论若显示在新商品下，会误导管理员确认订阅且破坏官方身份核对边界。
   */
  const sourcePreviewGeneration = useRef(0);
  const [resolutions, setResolutions] = useState<RegionResolutionResponse[]>([]);
  // 解析响应可能为空（例如仅启用默认区），因此单独记录已完成核验的默认区候选，不能以结果数组长度判断是否允许提交。
  const [resolvedCandidateKeys, setResolvedCandidateKeys] = useState<string[]>([]);
  /** 候选折叠状态只服务于当前跨区响应；每次重新搜索或核验都会清空，避免旧商品的 UI 键影响新结果。 */
  const [expandedRegionalKeys, setExpandedRegionalKeys] = useState<string[]>([]);
  const [manualLinks, setManualLinks] = useState<Record<string, string>>({});
  const [pendingLinkKey, setPendingLinkKey] = useState<string | null>(null);
  /**
   * 该集合只记录本次浏览器草稿确实由 AI 写入的候选键，既不保存模型文本也不参与确认载荷。
   * 管理员编辑输入框会立即移除标记，避免把人工覆写错误标成尚待确认的 AI 建议。
   */
  const [aiSuggestedCandidateKeys, setAiSuggestedCandidateKeys] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<SubscriptionConfirmationResult[]>([]);

  /**
   * 商品接口的 401 不能继续停留在旧向导页：认证壳层会卸载本组件以清除全部候选和地区映射。
   * 其他错误只显示服务端已脱敏的中文摘要，不能把采集器、数据库或外站错误直接呈现给管理员。
   */
  function handleProductError(error: unknown, fallbackMessage: string): void {
    if (error instanceof ProductApiError && error.status === 401) {
      onUnauthorized();
      return;
    }
    setNotice(error instanceof ProductApiError ? error.message : fallbackMessage);
  }

  /**
   * 新搜索或新默认区官方链接开始时撤销所有旧跨区请求的写入权，并立即关闭旧请求留下的局部加载状态。
   * 请求本身不能在浏览器端可靠取消，但代次守卫可阻止它在结算后把旧商品映射重新写入新的向导上下文。
   */
  function invalidateRegionResolutionGeneration(): void {
    regionResolutionGeneration.current += 1;
    setIsResolvingRegions(false);
  }

  /** 撤销在途来源预览的写入权；网络请求无需强制取消，代次守卫即可避免过期响应恢复已清理的候选状态。 */
  function invalidateSourcePreviewGeneration(): void {
    sourcePreviewGeneration.current += 1;
  }

  /**
   * 目录建议是同源的既有名称复用能力，只在首次选择当前候选后读取一次，绝不调用 AI。
   * 返回值只能预填仍为空的当前草稿：人工输入、AI 成功或更换候选后的任何非空值都具有更高优先级。
   */
  async function loadCatalogChineseNameSuggestion(candidate: OfficialProductCandidate, generation: number): Promise<void> {
    const selectedKey = candidateKey(candidate);
    const catalogKey = `catalog-${generation}-1`;
    try {
      const response = await gameNameApi.suggestNames([{
        // 目录关联键只在浏览器与同源服务间使用，避免把官方 URL 作为异步响应的匹配标识。
        candidateKey: catalogKey,
        canonicalTitle: candidate.canonicalTitle,
        publisher: candidate.publisher,
        productType: candidate.productType,
      }]);
      const displayNameZhCn = response.suggestions.find((entry) => entry.candidateKey === catalogKey)?.displayNameZhCn;
      if (nameSuggestionGeneration.current !== generation || displayNameZhCn === null || displayNameZhCn === undefined) return;
      setWizard((current) => current.selectedCandidateKeys[0] === selectedKey && current.chineseNameDrafts[selectedKey] === undefined
        ? setChineseNameDraft(current, selectedKey, displayNameZhCn)
        : current);
    } catch (error) {
      // 目录预填是可选体验；401 仍交认证壳处理，其他失败不遮盖人工名称输入或 AI 的独立状态提示。
      if (nameSuggestionGeneration.current !== generation) return;
      if (error instanceof GameNameApiError && error.status === 401) onUnauthorized();
    }
  }

  /**
   * 地区核验成功后，只向 AI 端点发送当前唯一候选的标题、发行商和类型；官方 URL 与 UI 身份键永不外发。
   * 代次和空草稿守卫拒绝旧搜索、切换候选或管理员编辑后的迟到响应；结果仅预填草稿，绝不触发保存。
   */
  async function loadAiChineseNameSuggestions(candidate: OfficialProductCandidate, generation: number): Promise<void> {
    setIsAiNameSuggestionLoading(true);
    const batch = aiSuggestionBatchSequence.current + 1;
    aiSuggestionBatchSequence.current = batch;
    const aiKey = `ai-${batch}-1`;
    const key = candidateKey(candidate);
    try {
      const response = await gameNameApi.suggestAiNames([{
        // 瞬时批次键只用于关联本次响应，不能携带官方 URL、游戏 ID 或任何订阅身份。
        candidateKey: aiKey,
        canonicalTitle: candidate.canonicalTitle,
        publisher: candidate.publisher,
        productType: candidate.productType,
      }]);
      if (nameSuggestionGeneration.current !== generation) return;
      const displayNameZhCn = response.suggestions.find((entry) => entry.candidateKey === aiKey)?.displayNameZhCn;
      if (displayNameZhCn === null || displayNameZhCn === undefined) {
        // low 与结构安全降级都会归一为 null；固定文案不含模型、密钥或外部响应，且不阻断管理员手工填写。
        setNotice("没有可用的 AI 中文名称建议，请手动填写。");
        return;
      }
      setWizard((current) => {
        // 空字符串和全空白同样是人工编辑意图；最终提交另行 trim 校验，AI 不得覆盖。
        if (current.selectedCandidateKeys[0] !== key || current.chineseNameDrafts[key] !== undefined) return current;
        setAiSuggestedCandidateKeys((keys) => [...new Set([...keys, key])]);
        return setChineseNameDraft(current, key, displayNameZhCn);
      });
    } catch (error) {
      if (nameSuggestionGeneration.current !== generation) return;
      // 401 必须交由认证壳卸载旧页面；503、超时和网络错误只给出脱敏提示，地区结果和人工确认保持可用。
      if (error instanceof GameNameApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof GameNameApiError ? error.message : "AI 中文名称建议暂时无法读取，请手动填写。");
    } finally {
      if (nameSuggestionGeneration.current === generation) setIsAiNameSuggestionLoading(false);
    }
  }

  /**
   * 选择新候选会撤销旧 AI 回写资格并清空本页派生状态；状态模块同时清除旧名称和地区草稿，
   * 防止前一官方商品的人工名称或地区链接被带入新商品。选择本身绝不发起 AI 请求。
   */
  function handleSelectCandidate(candidate: OfficialProductCandidate): void {
    const key = candidateKey(candidate);
    const nextKey = wizard.selectedCandidateKeys[0] === key ? null : key;
    // 选择变化不仅使 AI 响应失效，也必须撤销地区与手动链接请求的写入权；否则旧官方关系会跨商品污染确认载荷。
    invalidateRegionResolutionGeneration();
    invalidateSourcePreviewGeneration();
    nameSuggestionGeneration.current += 1;
    manualLinkResolutionGeneration.current += 1;
    currentSelectedCandidateKey.current = nextKey;
    setIsAiNameSuggestionLoading(false);
    setAiSuggestedCandidateKeys([]);
    setResolutions([]);
    setResolvedCandidateKeys([]);
    setManualLinks({});
    setPendingLinkKey(null);
    setWizard((current) => selectCandidate(current, key));
    // 取消选择没有候选可查询；选择新卡后只读取一次本地目录，AI 仍严格等待成功跨区核验。
    if (nextKey !== null) void loadCatalogChineseNameSuggestion(candidate, nameSuggestionGeneration.current);
  }

  /** 仅从当前官方搜索响应中派生已选项；旧搜索结果不会混进下一次批量确认。 */
  const selectedCandidates = useMemo(() => {
    if (wizard.searchResult.status !== "available") return [];
    return wizard.searchResult.candidates.filter((candidate) => wizard.selectedCandidateKeys.includes(candidateKey(candidate)));
  }, [wizard.searchResult, wizard.selectedCandidateKeys]);

  /** 向服务端发起默认区搜索；地区由服务端已保存的设置决定，浏览器不会提交可篡改的默认区参数。 */
  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setNotice("请输入游戏名称后再搜索。");
      return;
    }

    invalidateRegionResolutionGeneration();
    invalidateSourcePreviewGeneration();
    nameSuggestionGeneration.current += 1;
    manualLinkResolutionGeneration.current += 1;
    currentSelectedCandidateKey.current = null;
    // 新搜索会移除第三步旧候选，必须同步撤销其 AI 局部加载标记，防止迟到 finally 留下无归属状态。
    setIsAiNameSuggestionLoading(false);
    setIsSearching(true);
    setNotice(null);
    setResults([]);
    try {
      const searchResult = await api.searchProducts(trimmedQuery);
      setWizard({ ...createSubscriptionWizardState(searchResult), query: trimmedQuery });
      setResolutions([]);
      setResolvedCandidateKeys([]);
      setManualLinks({});
      setExpandedRegionalKeys([]);
      setAiSuggestedCandidateKeys([]);
    } catch (error) {
      handleProductError(error, "官方搜索暂时不可用，请稍后重试。");
    } finally {
      setIsSearching(false);
    }
  }

  /** 官方搜索不可用时，以管理员选定地区的官方链接进入相同候选与确认流程。 */
  async function handleFallbackLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fallbackLink.trim()) {
      setNotice("请粘贴任天堂官方商品链接。");
      return;
    }

    invalidateRegionResolutionGeneration();
    invalidateSourcePreviewGeneration();
    nameSuggestionGeneration.current += 1;
    manualLinkResolutionGeneration.current += 1;
    currentSelectedCandidateKey.current = null;
    // 回退链接同样会创建新候选上下文，旧 AI 请求只能被代次失效，不能继续占用局部加载提示。
    setIsAiNameSuggestionLoading(false);
    setIsSearching(true);
    setNotice(null);
    try {
      const candidate = await api.resolveOfficialLink(fallbackRegion, fallbackLink.trim());
      setWizard({ ...createSubscriptionWizardState({ status: "available", candidates: [candidate] }), query: candidate.canonicalTitle });
      setResolutions([]);
      setResolvedCandidateKeys([]);
      setManualLinks({});
      setExpandedRegionalKeys([]);
      setAiSuggestedCandidateKeys([]);
    } catch (error) {
      handleProductError(error, "官方链接核验未完成，请稍后重试。");
    } finally {
      setIsSearching(false);
    }
  }

  /** 对当前唯一默认区商品请求跨区匹配；响应仍保留默认区键，使服务端官方关系可审计且不会误绑其他搜索结果。 */
  async function handleResolveRegions() {
    if (selectedCandidates.length === 0) {
      setNotice("请先点击选择至少一个官方候选商品。");
      return;
    }

    const selectedCandidate = selectedCandidates[0];
    if (!selectedCandidate) return;
    const selectedKey = candidateKey(selectedCandidate);
    const generation = regionResolutionGeneration.current + 1;
    regionResolutionGeneration.current = generation;
    setIsResolvingRegions(true);
    setNotice(null);
    setExpandedRegionalKeys([]);
    try {
      const resolved = await api.resolveRegions([selectedCandidate]);
      // 代次相同还不够：选择事件会在旧闭包外发生，必须确认当前 UI 仍对应发起核验的唯一候选。
      if (regionResolutionGeneration.current !== generation || currentSelectedCandidateKey.current !== selectedKey) return;
      setResolutions(() => resolved);
      setResolvedCandidateKeys(() => [selectedKey]);
      // 自动结果仅来自 Node 服务对保存设置和官方身份的唯一匹配；页面不会自行按名称或价格猜测跨区商品。
      setWizard((current) => current.selectedCandidateKeys[0] === selectedKey ? applyAutomaticRegionResolutions(current, resolved) : current);
      // 每次成功核验都分配新的 AI 代次，使同一候选的旧批次不能写草稿、提示或提前关闭新批次 loading。
      nameSuggestionGeneration.current += 1;
      void loadAiChineseNameSuggestions(selectedCandidate, nameSuggestionGeneration.current);
    } catch (error) {
      if (regionResolutionGeneration.current !== generation) return;
      handleProductError(error, "跨区匹配未完成，请稍后重试。");
    } finally {
      if (regionResolutionGeneration.current === generation) setIsResolvingRegions(false);
    }
  }

  /** 写入某款游戏的一个核验地区及其来源方式；状态模块会同时撤销同区跳过，防止确认载荷冲突。 */
  function handleRegionalCandidate(
    selected: OfficialProductCandidate,
    regionCode: RegionCode,
    candidate: OfficialProductCandidate,
    source: RegionalProductMatchSource,
  ) {
    const selectedKey = candidateKey(selected);
    setWizard((current) => setRegionalCandidate(current, selectedKey, regionCode, candidate, source));
  }

  /** 只让 Node 服务解析和校验手动链接，成功后才把返回的官方候选绑定到当前游戏/地区。 */
  async function handleResolveRegionalLink(selected: OfficialProductCandidate, regionCode: RegionCode) {
    const selectedKey = candidateKey(selected);
    const key = regionalConfirmationKey(selectedKey, regionCode);
    const link = manualLinks[key]?.trim();
    if (!link) {
      setNotice("请先粘贴任天堂官方商品链接。");
      return;
    }

    const generation = manualLinkResolutionGeneration.current + 1;
    manualLinkResolutionGeneration.current = generation;
    const regionGeneration = regionResolutionGeneration.current;
    setPendingLinkKey(key);
    setNotice(null);
    try {
      // 已选默认区锚点必须随日区升级包人工链接一起交给 Node 服务；其他地区或类型会由服务端维持原页面解析流程。
      const candidate = await api.resolveOfficialLink(regionCode, link, selected);
      // 仅允许同一选择上下文中的最新手动请求写入；管理员切换候选或重发链接后，旧成功结果必须静默丢弃。
      if (
        manualLinkResolutionGeneration.current !== generation
        || regionResolutionGeneration.current !== regionGeneration
        || currentSelectedCandidateKey.current !== selectedKey
      ) return;
      setWizard((current) => current.selectedCandidateKeys[0] === selectedKey
        ? setRegionalCandidate(current, selectedKey, regionCode, candidate, "manual_link")
        : current);
    } catch (error) {
      if (manualLinkResolutionGeneration.current === generation && currentSelectedCandidateKey.current === selectedKey) {
        handleProductError(error, "地区商品链接核验失败，请检查链接后重试。");
      }
    } finally {
      // 旧 finally 不能清除管理员为当前候选新发起的校验加载标记。
      if (manualLinkResolutionGeneration.current === generation && currentSelectedCandidateKey.current === selectedKey) setPendingLinkKey(null);
    }
  }

  /**
   * 日区本地 Playwright 核验失败后仅在管理员点击时重新请求当前选择，避免 effect 因状态渲染循环自动重试。
   * 不清空 manualLinks，确保管理员在自动核验仍失败时保留已输入的官方链接；代次守卫负责阻止过期回写，函数式 setWizard 只确保同一代次更新读取最新状态。
   */
  async function handleRetryRegions() {
    if (selectedCandidates.length === 0) {
      setNotice("请先点击选择至少一个官方候选商品。");
      return;
    }

    const selectedCandidate = selectedCandidates[0];
    if (!selectedCandidate) return;
    const selectedKey = candidateKey(selectedCandidate);
    const generation = regionResolutionGeneration.current + 1;
    regionResolutionGeneration.current = generation;
    setIsResolvingRegions(true);
    setNotice(null);
    setExpandedRegionalKeys(() => []);
    try {
      const resolved = await api.resolveRegions([selectedCandidate]);
      // 重试同样必须同时匹配代次和当前唯一候选，避免旧 Playwright 结果复活已取消的地区面板。
      if (regionResolutionGeneration.current !== generation || currentSelectedCandidateKey.current !== selectedKey) return;
      setResolutions(() => resolved);
      setResolvedCandidateKeys(() => [selectedKey]);
      // 自动结果仍只能由 Node 服务最新的官方关系发现写入；函数式更新避免读取过期向导状态。
      setWizard((current) => current.selectedCandidateKeys[0] === selectedKey ? applyAutomaticRegionResolutions(current, resolved) : current);
      // 重新核验与首次核验同样代表一批独立外部建议，必须废止仍在结算的先前批次。
      nameSuggestionGeneration.current += 1;
      void loadAiChineseNameSuggestions(selectedCandidate, nameSuggestionGeneration.current);
    } catch (error) {
      if (regionResolutionGeneration.current !== generation) return;
      handleProductError(error, "跨区匹配未完成，请稍后重试。");
    } finally {
      if (regionResolutionGeneration.current === generation) setIsResolvingRegions(false);
    }
  }

  /** 把默认区选择与已确认地区转换成服务端的严格确认模型，重复的默认区永远只保留一次。 */
  function buildConfirmationInputs(): ConfirmedSubscriptionInput[] {
    return selectedCandidates.map((selected) => {
      const selectedKey = candidateKey(selected);
      const regions: ConfirmedRegionalProduct[] = [
        { ...selected, matchSource: "manual_selection" },
      ];

      for (const region of regionChoices) {
        if (region.code === selected.regionCode) continue;
        const key = regionalConfirmationKey(selectedKey, region.code);
        const candidate = wizard.regionalConfirmations[key];
        const matchSource = wizard.regionalConfirmationSources[key];
        if (candidate && matchSource) regions.push({ ...candidate, matchSource });
      }

      const skippedRegionCodes = resolutions
        .filter((resolution) => resolution.candidateKey === selectedKey)
        .flatMap((resolution) => wizard.skippedRegionalKeys.includes(regionalConfirmationKey(selectedKey, resolution.regionCode)) ? [resolution.regionCode] : []);
      // 本地 trim 仅防止因前端状态异常提交首尾空白；服务端会在官方身份重验后再次验证并决定词条或人工名称的实际落库规则。
      return { selected, displayNameZhCn: (wizard.chineseNameDrafts[selectedKey] ?? "").trim(), regions, skippedRegionCodes };
    });
  }

  /** 预览实际会使用的官方或已启用第三方回退来源，避免管理员在写入后才发现某区不可监控。 */
  async function handlePreviewSources() {
    if (selectedCandidates.length === 0) return;
    const selectedCandidate = selectedCandidates[0];
    if (!selectedCandidate) return;
    const selectedKey = candidateKey(selectedCandidate);
    const generation = sourcePreviewGeneration.current + 1;
    sourcePreviewGeneration.current = generation;
    setNotice(null);
    try {
      const inputs = buildConfirmationInputs();
      const previewGroups = await Promise.all(inputs.map((input) => api.previewSources(input.regions)));
      // 预览必须同时属于最新请求和当前唯一候选；否则旧商品的来源状态会在选择切换后错误复活。
      if (sourcePreviewGeneration.current !== generation || currentSelectedCandidateKey.current !== selectedKey) return;
      setWizard((current) => current.selectedCandidateKeys[0] === selectedKey
        ? { ...current, sourcePreviews: Object.fromEntries(inputs.map((input, index) => [candidateKey(input.selected), previewGroups[index]])) }
        : current);
    } catch (error) {
      if (sourcePreviewGeneration.current === generation && currentSelectedCandidateKey.current === selectedKey) {
        handleProductError(error, "来源预览未完成，请稍后重试。");
      }
    }
  }

  /** 最终确认由 Node 服务以单个 PostgreSQL 事务提交；成功前页面仍允许修改地区，不会产生半成品订阅。 */
  async function handleConfirmSubscriptions() {
    if (selectedCandidates.length === 0) return;
    setWizard((current) => ({ ...current, submitState: "submitting" }));
    setNotice(null);
    try {
      const confirmationResults = await api.confirmSubscriptions(buildConfirmationInputs());
      setResults(confirmationResults);
      setWizard((current) => ({ ...current, submitState: "succeeded" }));
    } catch (error) {
      setWizard((current) => ({ ...current, submitState: "failed" }));
      handleProductError(error, "订阅确认未完成，请稍后重试。");
    }
  }

  return (
    <main className="app-shell">
      <section className="subscription-page" aria-labelledby="page-title">
        <header className="page-header">
          <div>
            <p className="eyebrow">Switch Price Monitor</p>
            <h1 id="page-title">添加价格订阅</h1>
            <p>先在默认区选择官方商品，再核验需要监控的其他地区。</p>
          </div>
          <span className="page-header__badge">仅使用任天堂官方商店</span>
        </header>

        <section className="search-panel" aria-labelledby="search-title">
          <div>
            <p className="eyebrow">第一步</p>
            <h2 id="search-title">搜索默认区商品</h2>
          </div>
          <form className="search-form" onSubmit={handleSearch}>
            <label htmlFor="product-query">游戏名称</label>
            <div className="search-form__controls">
              <input
                id="product-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：Overcooked! 2"
                autoComplete="off"
              />
              <button className="primary-button" type="submit" disabled={isSearching}>
                {isSearching ? "搜索中…" : "搜索官方商品"}
              </button>
            </div>
          </form>
        </section>

        {wizard.searchResult.status === "unavailable" ? (
          <section className="fallback-panel" aria-labelledby="fallback-title">
            <h2 id="fallback-title">官方名称搜索暂不可用</h2>
            <p>{wizard.searchResult.message}</p>
            <form className="fallback-form" onSubmit={handleFallbackLink}>
              <select value={fallbackRegion} onChange={(event) => setFallbackRegion(event.target.value as RegionCode)} aria-label="官方链接所属地区">
                {regionChoices.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}
              </select>
              <input value={fallbackLink} onChange={(event) => setFallbackLink(event.target.value)} type="url" placeholder="粘贴任天堂官方商品链接" />
              <button className="primary-button" type="submit" disabled={isSearching}>核验官方链接</button>
            </form>
          </section>
        ) : null}

        {wizard.searchResult.status === "available" && wizard.searchResult.candidates.length > 0 ? (
          <section className="candidate-section" aria-labelledby="candidate-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">第二步</p>
                <h2 id="candidate-title">官方候选结果</h2>
                <p>点击选择一项；选中后显示暖色边框。</p>
              </div>
              <span>{wizard.selectedCandidateKeys.length === 1 ? "已选择 1 项" : "尚未选择"}</span>
            </div>
            <div className="candidate-grid">
              {wizard.searchResult.candidates.map((candidate) => {
                const key = candidateKey(candidate);
                return <CandidateCard key={key} candidate={candidate} selected={wizard.selectedCandidateKeys.includes(key)} onToggle={() => handleSelectCandidate(candidate)} />;
              })}
            </div>
            <div className="candidate-actions">
              <button className="secondary-button" type="button" onClick={handleResolveRegions} disabled={isSearching || isResolvingRegions || selectedCandidates.length === 0}>
                {isResolvingRegions ? "匹配中…" : "核验其他地区"}
              </button>
              <button className="secondary-button" type="button" onClick={handlePreviewSources} disabled={selectedCandidates.length === 0}>预览价格来源</button>
              <button className="primary-button" type="button" onClick={handleConfirmSubscriptions} disabled={wizard.submitState === "submitting" || selectedCandidates.some((candidate) => !resolvedCandidateKeys.includes(candidateKey(candidate))) || !canConfirmConfiguredRegions(wizard, selectedCandidates, resolutions) || !canConfirmChineseNames(wizard, selectedCandidates)}>
                {wizard.submitState === "submitting" ? "确认中…" : "确认订阅"}
              </button>
            </div>
          </section>
        ) : null}

        {hasNoOfficialCandidates(wizard.searchResult, wizard.query) ? (
          <section className="empty-search-result" aria-live="polite" aria-labelledby="empty-search-title">
            <p className="eyebrow">官方搜索已完成</p>
            <h2 id="empty-search-title">未找到美区官方候选商品</h2>
            <p>
              任天堂官方索引没有匹配“{wizard.query}”。请尝试完整商品名称与标点，例如 “Overcooked! 2”；
              若已找到商品页，也可在官方搜索不可用时粘贴官方链接核验。
            </p>
          </section>
        ) : null}

        {selectedCandidates.map((selected) => (
          <RegionalConfirmationPanel
            key={candidateKey(selected)}
            selected={selected}
            resolutions={resolutions}
            confirmedCandidates={wizard.regionalConfirmations}
            manualLinks={manualLinks}
            pendingLinkKey={pendingLinkKey}
            isRegionalInteractionDisabled={isSearching || isResolvingRegions}
            expandedRegionalKeys={expandedRegionalKeys}
            onSelectCandidate={(regionCode, candidate, source) => handleRegionalCandidate(selected, regionCode, candidate, source)}
            onManualLinkChange={(key, value) => setManualLinks((current) => ({ ...current, [key]: value }))}
            onResolveLink={(regionCode) => handleResolveRegionalLink(selected, regionCode)}
            onRetryRegions={handleRetryRegions}
            onToggleSkip={(regionCode) => setWizard((current) => skipRegionalConfirmation(current, candidateKey(selected), regionCode))}
            onToggleCandidateExpansion={(key) => setExpandedRegionalKeys((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])}
          />
        ))}

        {selectedCandidates.length > 0 ? (
          <section className="regional-confirmation" aria-labelledby="chinese-name-confirmation-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">第三步</p>
                <h2 id="chinese-name-confirmation-title">确认简体中文显示名称</h2>
                <p>目录建议仅用于预填；未命中时必须手动填写，最终仍以服务器复核的官方商品身份为准。</p>
              </div>
            </div>
            {isAiNameSuggestionLoading ? <p role="status" aria-label="正在生成 AI 中文名称建议">正在生成 AI 中文名称建议</p> : null}
            <div className="regional-confirmation__options">
              {selectedCandidates.map((selected) => {
                const key = candidateKey(selected);
                const inputId = `chinese-name-${key}`;
                return <label className="regional-option" key={key} htmlFor={inputId}>
                  <span>{selected.canonicalTitle} 的简体中文显示名称</span>
                  <input
                    id={inputId}
                    value={wizard.chineseNameDrafts[key] ?? ""}
                    // 任意人工编辑都撤销 AI 来源标记；名称本身仍只保存在按候选键隔离的草稿中，等待最终确认服务重验。
                    onChange={(event) => {
                      setAiSuggestedCandidateKeys((keys) => keys.filter((candidateKey) => candidateKey !== key));
                      setWizard((current) => setChineseNameDraft(current, key, event.target.value));
                    }}
                    required
                  />
                  {aiSuggestedCandidateKeys.includes(key) ? <small>AI 建议，待确认</small> : null}
                </label>;
              })}
            </div>
          </section>
        ) : null}

        {Object.entries(wizard.sourcePreviews).map(([key, preview]) => (
          <section className="source-preview" key={key}>
            <h2>价格来源预览</h2>
            <div className="source-preview__items">
              {preview.map((region) => (
                <p key={region.regionCode}>
                  <b>{region.regionCode}</b>：{region.officialStatus === "official-available" ? "任天堂官方价格" : "官方价格 ID 暂不可用"}
                  {region.fallbackSources.length > 0 ? `；可回退至 ${region.fallbackSources.join("、")}` : ""}
                </p>
              ))}
            </div>
          </section>
        ))}

        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {results.length > 0 ? (
          <section className="confirmation-result" aria-live="polite">
            <h2>订阅已处理</h2>
            {results.map((result) => <p key={result.subscriptionId}>{result.status === "created" ? "已创建" : "已存在"}：{result.gameId}</p>)}
          </section>
        ) : null}
      </section>
    </main>
  );
}
