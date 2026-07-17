import { useMemo, useState, type FormEvent } from "react";
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
  OfficialProductCandidate,
  OfficialSearchResult,
  RegionCode,
  RegionalProductMatchSource,
  SubscriptionConfirmationResult,
} from "../shared/domain";

/** 前端只访问同源 Worker；所有任天堂官方页解析与价格来源校验均由服务端执行。 */
const productApi = createProductApiClient();

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
  manualLinks,
  pendingLinkKey,
  onSelectCandidate,
  onManualLinkChange,
  onResolveLink,
  onToggleSkip,
}: {
  selected: OfficialProductCandidate;
  resolutions: RegionResolutionResponse[];
  confirmedCandidates: Record<string, OfficialProductCandidate>;
  manualLinks: Record<string, string>;
  pendingLinkKey: string | null;
  onSelectCandidate: (regionCode: RegionCode, candidate: OfficialProductCandidate, source: RegionalProductMatchSource) => void;
  onManualLinkChange: (key: string, value: string) => void;
  onResolveLink: (regionCode: RegionCode) => void;
  onToggleSkip: (regionCode: RegionCode) => void;
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
          return (
            <article className="regional-option" key={key}>
              <div>
                <span className="regional-option__region">{regionChoices.find((region) => region.code === resolution.regionCode)?.name}</span>
                <p>{resolutionLabel(resolution)}</p>
              </div>
              {resolution.status === "automatic" ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => onSelectCandidate(resolution.regionCode, resolution.candidate, "automatic")}
                >
                  {confirmed ? "已采用自动匹配" : "采用此匹配"}
                </button>
              ) : null}
              {resolution.status === "needs-manual-selection" ? (
                <div className="regional-option__candidates">
                  {resolution.candidates.map((candidate) => (
                    <button
                      type="button"
                      className={`compact-option${confirmed?.productUrl === candidate.productUrl ? " compact-option--selected" : ""}`}
                      key={candidate.productUrl}
                      onClick={() => onSelectCandidate(resolution.regionCode, candidate, "manual_selection")}
                    >
                      {candidate.canonicalTitle}
                    </button>
                  ))}
                </div>
              ) : null}
              {resolution.status === "needs-manual-link" ? (
                <div className="regional-option__link">
                  <input
                    type="url"
                    value={manualLinks[key] ?? ""}
                    onChange={(event) => onManualLinkChange(key, event.target.value)}
                    placeholder="粘贴该区任天堂官方商品链接"
                    aria-label={`${resolution.regionCode} 任天堂官方商品链接`}
                  />
                  <button type="button" className="text-button" disabled={pendingLinkKey === key} onClick={() => onResolveLink(resolution.regionCode)}>
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
 * 因此刷新、取消或认证失效都不会留下部分游戏、地区商品或未经验证的价格记录。
 */
export function SubscriptionWizardPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [wizard, setWizard] = useState<SubscriptionWizardState>(() => createSubscriptionWizardState(emptySearchResult));
  const [query, setQuery] = useState("");
  const [fallbackRegion, setFallbackRegion] = useState<RegionCode>("US");
  const [fallbackLink, setFallbackLink] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isResolvingRegions, setIsResolvingRegions] = useState(false);
  const [resolutions, setResolutions] = useState<RegionResolutionResponse[]>([]);
  // 解析响应可能为空（例如仅启用默认区），因此单独记录已完成核验的默认区候选，不能以结果数组长度判断是否允许提交。
  const [resolvedCandidateKeys, setResolvedCandidateKeys] = useState<string[]>([]);
  const [manualLinks, setManualLinks] = useState<Record<string, string>>({});
  const [confirmationSources, setConfirmationSources] = useState<Record<string, RegionalProductMatchSource>>({});
  const [pendingLinkKey, setPendingLinkKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<SubscriptionConfirmationResult[]>([]);

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

    setIsSearching(true);
    setNotice(null);
    setResults([]);
    try {
      const searchResult = await productApi.searchProducts(trimmedQuery);
      setWizard({ ...createSubscriptionWizardState(searchResult), query: trimmedQuery });
      setResolutions([]);
      setResolvedCandidateKeys([]);
      setManualLinks({});
      setConfirmationSources({});
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

    setIsSearching(true);
    setNotice(null);
    try {
      const candidate = await productApi.resolveOfficialLink(fallbackRegion, fallbackLink.trim());
      setWizard({ ...createSubscriptionWizardState({ status: "available", candidates: [candidate] }), query: candidate.canonicalTitle });
      setResolutions([]);
      setResolvedCandidateKeys([]);
      setManualLinks({});
      setConfirmationSources({});
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

    setIsResolvingRegions(true);
    setNotice(null);
    try {
      const resolved = await productApi.resolveRegions(selectedCandidates);
      setResolutions(resolved);
      setResolvedCandidateKeys(selectedCandidates.map((candidate) => candidateKey(candidate)));
      // 自动结果仅来自 Worker 对保存设置和官方身份的唯一匹配；页面不会自行按名称或价格猜测跨区商品。
      setWizard((current) => applyAutomaticRegionResolutions(current, resolved));
    } catch (error) {
      handleProductError(error, "跨区匹配未完成，请稍后重试。");
    } finally {
      setIsResolvingRegions(false);
    }
  }

  /** 写入某款游戏的一个核验地区及其来源方式，来源会随最终确认请求一并交给后端审计。 */
  function handleRegionalCandidate(
    selected: OfficialProductCandidate,
    regionCode: RegionCode,
    candidate: OfficialProductCandidate,
    source: RegionalProductMatchSource,
  ) {
    const selectedKey = candidateKey(selected);
    const confirmationKey = regionalConfirmationKey(selectedKey, regionCode);
    setWizard((current) => setRegionalCandidate(current, selectedKey, regionCode, candidate));
    setConfirmationSources((current) => ({ ...current, [confirmationKey]: source }));
  }

  /** 只让 Worker 解析和校验手动链接，成功后才把返回的官方候选绑定到当前游戏/地区。 */
  async function handleResolveRegionalLink(selected: OfficialProductCandidate, regionCode: RegionCode) {
    const selectedKey = candidateKey(selected);
    const key = regionalConfirmationKey(selectedKey, regionCode);
    const link = manualLinks[key]?.trim();
    if (!link) {
      setNotice("请先粘贴任天堂官方商品链接。");
      return;
    }

    setPendingLinkKey(key);
    setNotice(null);
    try {
      const candidate = await productApi.resolveOfficialLink(regionCode, link);
      handleRegionalCandidate(selected, regionCode, candidate, "manual_link");
    } catch (error) {
      handleProductError(error, "地区商品链接核验失败，请检查链接后重试。");
    } finally {
      setPendingLinkKey(null);
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
        const matchSource = confirmationSources[key];
        if (candidate && matchSource) regions.push({ ...candidate, matchSource });
      }

      const skippedRegionCodes = resolutions
        .filter((resolution) => resolution.candidateKey === selectedKey)
        .flatMap((resolution) => wizard.skippedRegionalKeys.includes(regionalConfirmationKey(selectedKey, resolution.regionCode)) ? [resolution.regionCode] : []);
      return { selected, regions, skippedRegionCodes };
    });
  }

  /** 预览实际会使用的官方或已启用第三方回退来源，避免管理员在写入后才发现某区不可监控。 */
  async function handlePreviewSources() {
    if (selectedCandidates.length === 0) return;
    setNotice(null);
    try {
      const inputs = buildConfirmationInputs();
      const previewGroups = await Promise.all(inputs.map((input) => productApi.previewSources(input.regions)));
      setWizard((current) => ({
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
    setWizard((current) => ({ ...current, submitState: "submitting" }));
    setNotice(null);
    try {
      const confirmationResults = await productApi.confirmSubscriptions(buildConfirmationInputs());
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
                <p>点击栏目可多选；选中后显示暖色边框。</p>
              </div>
              <span>{wizard.selectedCandidateKeys.length} 项已选</span>
            </div>
            <div className="candidate-grid">
              {wizard.searchResult.candidates.map((candidate) => {
                const key = candidateKey(candidate);
                return <CandidateCard key={key} candidate={candidate} selected={wizard.selectedCandidateKeys.includes(key)} onToggle={() => setWizard((current) => toggleCandidate(current, key))} />;
              })}
            </div>
            <div className="candidate-actions">
              <button className="secondary-button" type="button" onClick={handleResolveRegions} disabled={isResolvingRegions || selectedCandidates.length === 0}>
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
            manualLinks={manualLinks}
            pendingLinkKey={pendingLinkKey}
            onSelectCandidate={(regionCode, candidate, source) => handleRegionalCandidate(selected, regionCode, candidate, source)}
            onManualLinkChange={(key, value) => setManualLinks((current) => ({ ...current, [key]: value }))}
            onResolveLink={(regionCode) => handleResolveRegionalLink(selected, regionCode)}
            onToggleSkip={(regionCode) => setWizard((current) => skipRegionalConfirmation(current, candidateKey(selected), regionCode))}
          />
        ))}

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
