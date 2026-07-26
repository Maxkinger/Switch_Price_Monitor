import { useMemo, useRef, useState, type FormEvent } from "react";
import { createProductApiClient, ProductApiError, type RegionResolutionResponse } from "./api-client";
import {
  candidatePriceLabel,
  applyAutomaticRegionResolutions,
  canConfirmConfiguredRegions,
  createSubscriptionWizardState,
  hasNoOfficialCandidates,
  regionalConfirmationKey,
  setRegionalCandidate,
  skipRegionalConfirmation,
  toggleCandidate,
  type CandidatePriceLabel,
  type SubscriptionWizardState,
} from "./subscription-wizard";
import type {
  ConfirmedRegionalProduct,
  ConfirmedSubscriptionInput,
  GameNamePreview,
  OfficialProductCandidate,
  OfficialSearchResult,
  RegionCode,
  RegionalProductMatchSource,
  SubscriptionConfirmationResult,
} from "../shared/domain";

/**
 * 地区标签仅用于 UI 文案与官方链接回退选择，绝不代表跨区业务范围。
 * 实际启用地区由 Worker 设置决定，向导不会把此展示常量发送给跨区解析接口。
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
 * 单个官方候选商品卡。整张卡是可多选按钮，避免“选择”按钮与卡片点击产生两套不一致的状态；
 * 图片仅使用 Worker 返回的公开封面 URL，缺图时保留固定占位，不影响名称、类型和价格核对。
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
 * 手动链接只送到 Worker 验证，不能把用户输入直接作为地区商品或价格来源保存。
 */
function RegionalConfirmationPanel({
  selected,
  resolutions,
  confirmedCandidates,
  gameNamePreview,
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
  /** 名称预览只能由本轮官方地区核验后的 Worker 返回；港区卡不能由标题或输入链接自行猜测中文。 */
  gameNamePreview: GameNamePreview | undefined;
  manualLinks: Record<string, string>;
  pendingLinkKey: string | null;
  /** 搜索或地区解析进行中时禁止会发网的地区操作，避免旧面板在新搜索尚未结算时启动并发 Browser Run。 */
  isRegionalInteractionDisabled: boolean;
  /** 展开键只控制当前页面的候选可见性，不能参与地区确认、跳过或最终订阅载荷。 */
  expandedRegionalKeys: string[];
  onSelectCandidate: (regionCode: RegionCode, candidate: OfficialProductCandidate, source: RegionalProductMatchSource) => void;
  onManualLinkChange: (key: string, value: string) => void;
  onResolveLink: (regionCode: RegionCode) => void;
  /** 日区自动关系发现失败时由管理员显式再次触发；该点击不读取 effect，避免后台反复消耗 Browser Run 配额。 */
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
          // Worker 已按官方身份信号排序并给出首屏数量；前端只消费这个受控结果，不能自行按标题、价格或搜索顺序猜测商品关系。
          const visibleCandidates = resolution.status === "needs-manual-selection" && !isExpanded
            ? resolution.candidates.slice(0, resolution.featuredCandidateCount)
            : resolution.status === "needs-manual-selection" ? resolution.candidates : [];
          const hiddenCandidateCount = resolution.status === "needs-manual-selection"
            ? resolution.candidates.length - visibleCandidates.length
            : 0;
          // 港区仅以 Worker 已确认的中文预览替换主标题，原始官方标题仍保留作身份核对，避免展示层改写地区商品。
          const hongKongName = resolution.regionCode === "HK" ? gameNamePreview?.nameZh : null;
          return (
            <article className="regional-option" key={key}>
              <div>
                <span className="regional-option__region">{regionChoices.find((region) => region.code === resolution.regionCode)?.name}</span>
                <p>{resolutionLabel(resolution)}</p>
              </div>
              {resolution.status === "automatic" ? (
                <small className="regional-option__confirmed">已自动加入监控：{hongKongName ?? resolution.candidate.canonicalTitle}</small>
              ) : null}
              {resolution.regionCode === "HK" && hongKongName && confirmed ? <small className="regional-option__confirmed">官方标题：{confirmed.canonicalTitle}</small> : null}
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
                  {resolution.regionCode === "HK" && !confirmed ? <small>核验后可确定中文名称</small> : null}
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
              {/* 自动结果已在上方作为卡片主状态展示；不重复输出同一名称，手动选择和手动链接仍保留“已确认”以说明管理员动作已生效。 */}
              {confirmed && resolution.status !== "automatic" ? <small className="regional-option__confirmed">已确认：{hongKongName ?? confirmed.canonicalTitle}</small> : null}
              {resolution.regionCode === "HK" && gameNamePreview?.source === "unavailable" ? <small>最终确认时可填写中文名称或保留官方英文标题</small> : null}
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
export function SubscriptionWizardPage({ api, onUnauthorized }: { api: ReturnType<typeof createProductApiClient>; onUnauthorized: () => void }) {
  const [wizard, setWizardState] = useState<SubscriptionWizardState>(() => createSubscriptionWizardState(emptySearchResult));
  // 地区解析与人工链接均会跨越异步边界；此引用始终指向最近一次已派生状态，避免慢速预览用旧闭包覆盖管理员刚修改的选择或跳过决定。
  const wizardStateRef = useRef(wizard);
  wizardStateRef.current = wizard;
  /**
   * 所有向导改动都经由同一函数式更新进入 React 状态和同步引用。
   * 这样网络响应可先从最新状态派生预览输入，再发起只读请求，而不会在 state updater 内启动副作用或丢失并发的管理员操作。
   */
  function updateWizard(updater: SubscriptionWizardState | ((current: SubscriptionWizardState) => SubscriptionWizardState)): void {
    setWizardState((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      wizardStateRef.current = next;
      return next;
    });
  }
  const [query, setQuery] = useState("");
  const [fallbackRegion, setFallbackRegion] = useState<RegionCode>("US");
  const [fallbackLink, setFallbackLink] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isResolvingRegions, setIsResolvingRegions] = useState(false);
  /**
   * 每次跨区解析都持有递增代次。搜索、官方链接回退或下一次解析会使旧代次失效，
   * 这样慢速 Browser Run 的成功、失败和 finally 都不能覆盖后来搜索的地区结果或加载状态。
   */
  const regionResolutionGeneration = useRef(0);
  const [resolutions, setResolutions] = useState<RegionResolutionResponse[]>([]);
  // 解析响应可能为空（例如仅启用默认区），因此单独记录已完成核验的默认区候选，不能以结果数组长度判断是否允许提交。
  const [resolvedCandidateKeys, setResolvedCandidateKeys] = useState<string[]>([]);
  /** 候选折叠状态只服务于当前跨区响应；每次重新搜索或核验都会清空，避免旧商品的 UI 键影响新结果。 */
  const [expandedRegionalKeys, setExpandedRegionalKeys] = useState<string[]>([]);
  const [manualLinks, setManualLinks] = useState<Record<string, string>>({});
  const [pendingLinkKey, setPendingLinkKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<SubscriptionConfirmationResult[]>([]);
  // 名称预览按默认区官方 URL 绑定，地区候选改动时会清空；浏览器不保存网页正文或来源推断，只保存 Worker 返回的脱敏展示 DTO。
  const [gameNamePreviews, setGameNamePreviews] = useState<Record<string, GameNamePreview>>({});
  // 人工中文只在官方预览不可用时由管理员填写；空白不在页面转义为中文，交给服务端明确保存官方英文回退。
  const [manualGameNames, setManualGameNames] = useState<Record<string, string>>({});

  /**
   * 商品接口的 401 不能继续停留在旧向导页：认证壳层会卸载本组件以清除全部候选和地区映射。
   * 其他错误只显示 Worker 已脱敏的中文摘要，不能把采集器、数据库或外站错误直接呈现给管理员。
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
    setIsSearching(true);
    setNotice(null);
    setResults([]);
    try {
      const searchResult = await api.searchProducts(trimmedQuery);
      updateWizard({ ...createSubscriptionWizardState(searchResult), query: trimmedQuery });
      setResolutions([]);
      setResolvedCandidateKeys([]);
      setManualLinks({});
      setExpandedRegionalKeys([]);
      setGameNamePreviews({});
      setManualGameNames({});
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
    setIsSearching(true);
    setNotice(null);
    try {
      const candidate = await api.resolveOfficialLink(fallbackRegion, fallbackLink.trim());
      updateWizard({ ...createSubscriptionWizardState({ status: "available", candidates: [candidate] }), query: candidate.canonicalTitle });
      setResolutions([]);
      setResolvedCandidateKeys([]);
      setManualLinks({});
      setExpandedRegionalKeys([]);
      setGameNamePreviews({});
      setManualGameNames({});
    } catch (error) {
      handleProductError(error, "官方链接核验未完成，请稍后重试。");
    } finally {
      setIsSearching(false);
    }
  }

  /** 对所有已选默认区商品并行请求跨区匹配；结果带有默认区键，确保多选游戏不会串区。 */
  async function handleResolveRegions() {
    if (selectedCandidates.length === 0) {
      setNotice("请先点击选择至少一个官方候选商品。");
      return;
    }

    const generation = regionResolutionGeneration.current + 1;
    regionResolutionGeneration.current = generation;
    setIsResolvingRegions(true);
    setNotice(null);
    setExpandedRegionalKeys([]);
    setGameNamePreviews({});
    setManualGameNames({});
    try {
      const resolved = await api.resolveRegions(selectedCandidates);
      if (regionResolutionGeneration.current !== generation) return;
      setResolutions(() => resolved);
      setResolvedCandidateKeys(() => selectedCandidates.map((candidate) => candidateKey(candidate)));
      // 自动结果仅来自 Worker 对保存设置和官方身份的唯一匹配；页面不会自行按名称或价格猜测跨区商品。
      const nextWizard = applyAutomaticRegionResolutions(wizardStateRef.current, resolved);
      updateWizard(nextWizard);
      void refreshGameNamePreviews(nextWizard, resolved, generation);
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
    // 香港候选变化会影响大陆同 ID 与香港繁转简的判定，旧预览必须失效，避免管理员把上一轮名称当成本轮官方结果。
    setGameNamePreviews({});
    updateWizard((current) => setRegionalCandidate(current, selectedKey, regionCode, candidate, source));
  }

  /**
   * 只让 Worker 解析和校验手动链接，成功后才把返回的官方候选绑定到当前游戏/地区并刷新名称。
   * 必须复用本轮地区核验代次：新搜索或重新核验已使旧代次失效时，慢速链接响应不得恢复旧商品或旧中文名称。
   */
  async function handleResolveRegionalLink(selected: OfficialProductCandidate, regionCode: RegionCode) {
    const selectedKey = candidateKey(selected);
    const key = regionalConfirmationKey(selectedKey, regionCode);
    const link = manualLinks[key]?.trim();
    if (!link) {
      setNotice("请先粘贴任天堂官方商品链接。");
      return;
    }

    const generation = regionResolutionGeneration.current;
    setPendingLinkKey(key);
    setNotice(null);
    try {
      // 已选默认区锚点必须随日区升级包人工链接一起交给 Worker；其他地区或类型会由服务端维持原页面解析流程。
      const candidate = await api.resolveOfficialLink(regionCode, link, selected);
      if (regionResolutionGeneration.current !== generation) return;
      // 链接候选与自动候选同样会影响大陆同 ID 优先和香港繁转简；先清除旧值，再以已核验的候选立即请求 Worker 名称预览。
      const nextWizard = setRegionalCandidate(wizardStateRef.current, selectedKey, regionCode, candidate, "manual_link");
      setGameNamePreviews({});
      updateWizard(nextWizard);
      void refreshGameNamePreviews(nextWizard, resolutions, generation);
    } catch (error) {
      handleProductError(error, "地区商品链接核验失败，请检查链接后重试。");
    } finally {
      setPendingLinkKey(null);
    }
  }

  /**
   * 日区 Browser Run 失败后仅在管理员点击时重新请求当前选择，避免 effect 因状态渲染循环自动重试。
   * 不清空 manualLinks，确保管理员在自动核验仍失败时保留已输入的官方链接；代次守卫负责阻止过期回写，刷新预览使用已派生的同一轮状态，避免等待 React 状态异步结算。
   */
  async function handleRetryRegions() {
    if (selectedCandidates.length === 0) {
      setNotice("请先点击选择至少一个官方候选商品。");
      return;
    }

    const generation = regionResolutionGeneration.current + 1;
    regionResolutionGeneration.current = generation;
    setIsResolvingRegions(true);
    setNotice(null);
    setExpandedRegionalKeys(() => []);
    try {
      const resolved = await api.resolveRegions(selectedCandidates);
      if (regionResolutionGeneration.current !== generation) return;
      setResolutions(() => resolved);
      setResolvedCandidateKeys(() => selectedCandidates.map((candidate) => candidateKey(candidate)));
      // 自动结果仍只能由 Worker 的最新官方关系发现写入；同一派生状态也会立即传给名称预览，避免暂时读取到旧的 HK URL。
      const nextWizard = applyAutomaticRegionResolutions(wizardStateRef.current, resolved);
      updateWizard(nextWizard);
      void refreshGameNamePreviews(nextWizard, resolved, generation);
    } catch (error) {
      if (regionResolutionGeneration.current !== generation) return;
      handleProductError(error, "跨区匹配未完成，请稍后重试。");
    } finally {
      if (regionResolutionGeneration.current === generation) setIsResolvingRegions(false);
    }
  }

  /** 把默认区选择与已确认地区转换成服务端的严格确认模型，重复的默认区永远只保留一次。 */
  function buildConfirmationInputs(state = wizard, effectiveResolutions = resolutions): ConfirmedSubscriptionInput[] {
    return selectedCandidates.map((selected) => {
      const selectedKey = candidateKey(selected);
      const regions: ConfirmedRegionalProduct[] = [
        { ...selected, matchSource: "manual_selection" },
      ];

      for (const region of regionChoices) {
        if (region.code === selected.regionCode) continue;
        const key = regionalConfirmationKey(selectedKey, region.code);
        const candidate = state.regionalConfirmations[key];
        const matchSource = state.regionalConfirmationSources[key];
        if (candidate && matchSource) regions.push({ ...candidate, matchSource });
      }

      const skippedRegionCodes = effectiveResolutions
        .filter((resolution) => resolution.candidateKey === selectedKey)
        .flatMap((resolution) => state.skippedRegionalKeys.includes(regionalConfirmationKey(selectedKey, resolution.regionCode)) ? [resolution.regionCode] : []);
      // 已出现 unavailable 预览时，空字符串是管理员明确接受英文回退的决定；首次请求预览前仍不附带该字段，避免旧候选在没有名称状态时伪造人工决定。
      const displayNameZh = manualGameNames[selectedKey] ?? (gameNamePreviews[selectedKey]?.source === "unavailable" ? "" : undefined);
      return { selected, regions, skippedRegionCodes, ...(displayNameZh === undefined ? {} : { displayNameZh }) };
    });
  }

  /**
   * 即时预览只读取刚完成核验的候选，并以代次拒绝旧请求回写；
   * 这样慢速大陆或香港响应不能覆盖新搜索、重试或链接重新核验后的地区映射。
   */
  async function refreshGameNamePreviews(
    state: SubscriptionWizardState,
    effectiveResolutions: RegionResolutionResponse[],
    generation: number,
  ): Promise<void> {
    try {
      // 传入刚完成的地区响应而非等待 React 状态结算，保证名称服务实际取得本轮已核验的 HK URL。
      const inputs = buildConfirmationInputs(state, effectiveResolutions);
      const previews = await api.previewGameNames(inputs);
      if (regionResolutionGeneration.current !== generation || previews.length !== inputs.length) return;
      setGameNamePreviews(Object.fromEntries(inputs.map((input, index) => [candidateKey(input.selected), previews[index]])));
    } catch (error) {
      if (regionResolutionGeneration.current !== generation) return;
      handleProductError(error, "游戏名称预览暂时无法完成，请稍后重试。");
    }
  }

  /**
   * 仅在地区校验结束后显式取得名称预览。预览失败不会创建订阅，且来源文字完全取自 Worker，
   * 因为大陆同 ID、香港标题与人工回退的最终优先级仍要在保存前由 Worker 重算。
   */
  async function handlePreviewGameNames(): Promise<boolean> {
    if (selectedCandidates.length === 0) return false;
    setNotice(null);
    try {
      const inputs = buildConfirmationInputs();
      const previews = await api.previewGameNames(inputs);
      if (previews.length !== inputs.length) {
        setNotice("游戏名称预览暂时无法完成，请稍后重试。");
        return false;
      }
      setGameNamePreviews(Object.fromEntries(inputs.map((input, index) => [candidateKey(input.selected), previews[index]])));
      return true;
    } catch (error) {
      handleProductError(error, "游戏名称预览暂时无法完成，请稍后重试。");
      return false;
    }
  }

  /** 预览实际会使用的官方或已启用第三方回退来源，避免管理员在写入后才发现某区不可监控。 */
  async function handlePreviewSources() {
    if (selectedCandidates.length === 0) return;
    setNotice(null);
    try {
      const inputs = buildConfirmationInputs();
      const previewGroups = await Promise.all(inputs.map((input) => api.previewSources(input.regions)));
      updateWizard((current) => ({
        ...current,
        sourcePreviews: Object.fromEntries(inputs.map((input, index) => [candidateKey(input.selected), previewGroups[index]])),
      }));
    } catch (error) {
      handleProductError(error, "来源预览未完成，请稍后重试。");
    }
  }

  /** 最终确认由 Worker 以单个 D1 批次提交；成功前页面仍允许修改地区，不会产生半成品订阅。 */
  async function handleConfirmSubscriptions() {
    if (selectedCandidates.length === 0) return;
    // 第一次确认点击只取得名称预览；这样管理员在任何 D1 写入前可看到官方来源或明确输入人工中文，不会由页面猜测译名。
    if (selectedCandidates.some((candidate) => gameNamePreviews[candidateKey(candidate)] === undefined)) {
      await handlePreviewGameNames();
      return;
    }
    updateWizard((current) => ({ ...current, submitState: "submitting" }));
    setNotice(null);
    try {
      const confirmationResults = await api.confirmSubscriptions(buildConfirmationInputs());
      setResults(confirmationResults);
      updateWizard((current) => ({ ...current, submitState: "succeeded" }));
    } catch (error) {
      updateWizard((current) => ({ ...current, submitState: "failed" }));
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
                <p>点击栏目可多选；选中后显示暖色边框。</p>
              </div>
              <span>{wizard.selectedCandidateKeys.length} 项已选</span>
            </div>
            <div className="candidate-grid">
              {wizard.searchResult.candidates.map((candidate) => {
                const key = candidateKey(candidate);
                return <CandidateCard key={key} candidate={candidate} selected={wizard.selectedCandidateKeys.includes(key)} onToggle={() => {
                  // 新选择会改变待确认锚点，清空旧预览后必须再次由 Worker 读取官方名称，不能沿用另一商品的来源标签。
                  setGameNamePreviews({});
                  setManualGameNames({});
                  updateWizard((current) => toggleCandidate(current, key));
                }} />;
              })}
            </div>
            <div className="candidate-actions">
              <button className="secondary-button" type="button" onClick={handleResolveRegions} disabled={isSearching || isResolvingRegions || selectedCandidates.length === 0}>
                {isResolvingRegions ? "匹配中…" : "核验其他地区"}
              </button>
              <button className="secondary-button" type="button" onClick={handlePreviewSources} disabled={selectedCandidates.length === 0}>预览价格来源</button>
              <button className="primary-button" type="button" onClick={handleConfirmSubscriptions} disabled={wizard.submitState === "submitting" || selectedCandidates.some((candidate) => !resolvedCandidateKeys.includes(candidateKey(candidate))) || !canConfirmConfiguredRegions(wizard, selectedCandidates, resolutions)}>
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
            gameNamePreview={gameNamePreviews[candidateKey(selected)]}
            manualLinks={manualLinks}
            pendingLinkKey={pendingLinkKey}
            isRegionalInteractionDisabled={isSearching || isResolvingRegions}
            expandedRegionalKeys={expandedRegionalKeys}
            onSelectCandidate={(regionCode, candidate, source) => handleRegionalCandidate(selected, regionCode, candidate, source)}
            onManualLinkChange={(key, value) => setManualLinks((current) => ({ ...current, [key]: value }))}
            onResolveLink={(regionCode) => handleResolveRegionalLink(selected, regionCode)}
            onRetryRegions={handleRetryRegions}
            onToggleSkip={(regionCode) => {
              // 跳过或恢复香港区会改变可验证名称来源，因此必须取消预览并要求管理员重新查看结果。
              setGameNamePreviews({});
              updateWizard((current) => skipRegionalConfirmation(current, candidateKey(selected), regionCode));
            }}
            onToggleCandidateExpansion={(key) => setExpandedRegionalKeys((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])}
          />
        ))}

        {selectedCandidates.map((selected) => {
          const preview = gameNamePreviews[candidateKey(selected)];
          if (!preview) return null;
          if (preview.source === "mainland_official") {
            return <section className="game-name-preview" key={`game-name:${candidateKey(selected)}`}><p>已采用腾讯 Nintendo Switch 官方中文名称：{preview.nameZh}</p></section>;
          }
          if (preview.source === "hong_kong_official") {
            return <section className="game-name-preview" key={`game-name:${candidateKey(selected)}`}><p>已采用任天堂香港官方中文名称：{preview.nameZh}</p></section>;
          }
          return <section className="game-name-preview" key={`game-name:${candidateKey(selected)}`}>
            <label>
              中文展示名称
              <input
                aria-label="中文展示名称"
                value={manualGameNames[candidateKey(selected)] ?? ""}
                onChange={(event) => setManualGameNames((current) => ({ ...current, [candidateKey(selected)]: event.target.value }))}
                placeholder="可填写人工中文名称"
              />
            </label>
            <p>留空将使用官方英文标题</p>
          </section>;
        })}

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
