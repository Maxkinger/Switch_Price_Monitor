import { useEffect, useMemo, useState } from "react";

import type { ConfirmedRegionalProduct, OfficialProductCandidate, RegionCode, RegionalProductMatchSource } from "../shared/domain";
import { ProductApiError, createProductApiClient, type RegionResolutionResponse } from "./api-client";
import { DashboardApiError, type CompletedRefreshResult, type MissingRegionCompletionInput, type SubscriptionDetail, type SubscriptionUpdate } from "./dashboard-api-client";
import { formatCnyFen, formatLocalPrice } from "./dashboard-view-model";
import { applyAutomaticMissingResolutions, immediateRefreshNotice, missingRegionPresentation } from "./dashboard-page-state";

/** 详情页只依赖受控详情读取、立即采集、编辑和地区补全接口；游戏身份与启用地区范围始终由 Worker 读取。 */
interface DetailApi {
  getSubscription(id: string): Promise<SubscriptionDetail>;
  refreshNow(): Promise<CompletedRefreshResult>;
  updateSubscription(id: string, update: SubscriptionUpdate): Promise<unknown>;
  resolveMissingRegions(id: string): Promise<RegionResolutionResponse[]>;
  completeMissingRegions(id: string, input: MissingRegionCompletionInput): Promise<unknown>;
}

/**
 * 单页订阅详情提供三个独立保存操作：启用状态、已确认地区范围和目标价。
 * 页面不接受商品 ID 文本输入；地区复选框只来自 Worker 返回的已确认映射，商品客户端由应用壳共享以纳入全局加载状态。
 */
export function SubscriptionDetailPage({ api, productApi, subscriptionId, onBack, onUnauthorized }: { api: DetailApi; productApi: ReturnType<typeof createProductApiClient>; subscriptionId: string; onBack: () => void; onUnauthorized: () => void }) {
  const [detail, setDetail] = useState<SubscriptionDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [globalTarget, setGlobalTarget] = useState("");
  const [regionalTargets, setRegionalTargets] = useState<Record<string, string>>({});
  const monitoredIds = useMemo(() => new Set(detail?.regions.filter((region) => region.monitored).map((region) => region.regionalProductId) ?? []), [detail]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [missingResolutions, setMissingResolutions] = useState<RegionResolutionResponse[]>([]);
  const [missingConfirmations, setMissingConfirmations] = useState<Record<string, ConfirmedRegionalProduct>>({});
  const [missingSkipped, setMissingSkipped] = useState<RegionCode[]>([]);
  const [isResolvingMissing, setIsResolvingMissing] = useState(false);
  const [isCompletingMissing, setIsCompletingMissing] = useState(false);

  async function reload(): Promise<boolean> {
    try {
      const next = await api.getSubscription(subscriptionId);
      setDetail(next); setSelectedIds(new Set(next.regions.filter((region) => region.monitored).map((region) => region.regionalProductId)));
      setGlobalTarget(next.globalTargetCnyFen === null ? "" : String(next.globalTargetCnyFen));
      setRegionalTargets(Object.fromEntries(next.regionTargets.map((target) => [target.regionCode, String(target.targetAmountMinor)])));
      return true;
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else if (error instanceof DashboardApiError && error.status === 404) { onBack(); }
      else setNotice(error instanceof DashboardApiError ? error.message : "订阅详情暂时无法读取。");
      return false;
    }
  }

  useEffect(() => { void reload(); }, [subscriptionId]); // 订阅 ID 改变时重新读取，不能复用上一张卡片的价格与目标价。

  async function save(update: SubscriptionUpdate, success: string): Promise<void> {
    setNotice(null);
    try { await api.updateSubscription(subscriptionId, update); await reload(); setNotice(success); }
    catch (error) { if (error instanceof DashboardApiError && error.status === 401) onUnauthorized(); else setNotice(error instanceof DashboardApiError ? error.message : "保存未完成，请稍后重试。"); }
  }

  async function refreshNow(): Promise<void> {
    setNotice(null);
    try {
      const result = await api.refreshNow();
      // 只有详情重新读取成功时才提示本轮完成，避免认证失效或订阅删除后仍显示已更新的旧页面。
      if (await reload()) setNotice(immediateRefreshNotice(result));
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof DashboardApiError ? error.message : "刷新暂时无法完成。");
    }
  }

  /** 从 Worker 读取当前订阅锚点对应的缺失地区；重复打开会清除旧草稿，避免将上一轮候选提交到新设置范围。 */
  async function resolveMissingRegions(): Promise<void> {
    setIsResolvingMissing(true); setNotice(null);
    try {
      const resolutions = await api.resolveMissingRegions(subscriptionId);
      // 仅唯一严格匹配可直接成为草稿；它仍要经过下方“确认补全”的原子写入，浏览器绝不自动保存地区。
      setMissingResolutions(resolutions); setMissingConfirmations(applyAutomaticMissingResolutions(resolutions)); setMissingSkipped([]);
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof DashboardApiError ? error.message : "缺失地区暂时无法解析。");
    } finally { setIsResolvingMissing(false); }
  }

  /** 自动候选由 Worker 已完成唯一身份匹配；手动候选/链接仍需管理员动作，不能按名称或价格自行猜测。 */
  function acceptMissingCandidate(resolution: RegionResolutionResponse, candidate: OfficialProductCandidate, matchSource: RegionalProductMatchSource): void {
    setMissingConfirmations((current) => ({ ...current, [resolution.regionCode]: { ...candidate, matchSource } }));
    setMissingSkipped((current) => current.filter((region) => region !== resolution.regionCode));
  }

  /** 手动链接只交给商品 Worker 解析，成功后立即以 `manual_link` 记录映射来源，不能直接信任输入 URL。 */
  async function resolveMissingLink(regionCode: RegionCode, productUrl: string): Promise<void> {
    try { acceptMissingCandidate({ candidateKey: "", regionCode, status: "needs-manual-link", message: "" }, await productApi.resolveOfficialLink(regionCode, productUrl), "manual_link"); }
    catch (error) { if (error instanceof ProductApiError && error.status === 401) onUnauthorized(); else setNotice(error instanceof ProductApiError ? error.message : "官方链接核验失败。"); }
  }

  /** 所有解析地区都需要确认或跳过；满足后才调用服务端原子补全，并以 reload 作为唯一的详情状态来源。 */
  async function completeMissingRegions(): Promise<void> {
    if (missingResolutions.some((resolution) => !missingConfirmations[resolution.regionCode] && !missingSkipped.includes(resolution.regionCode))) return;
    setIsCompletingMissing(true); setNotice(null);
    try {
      await api.completeMissingRegions(subscriptionId, { regions: Object.values(missingConfirmations), skippedRegionCodes: missingSkipped });
      if (await reload()) { setMissingResolutions([]); setMissingConfirmations({}); setMissingSkipped([]); setNotice("已补全已启用地区。"); }
    } catch (error) { if (error instanceof DashboardApiError && error.status === 401) onUnauthorized(); else setNotice(error instanceof DashboardApiError ? error.message : "地区补全未完成。"); }
    finally { setIsCompletingMissing(false); }
  }

  if (!detail) return <p className="page-loading">正在读取订阅详情…</p>;
  return <section className="detail-page" aria-labelledby="detail-title">
    <button type="button" className="text-button" onClick={onBack}>← 返回仪表盘</button>
    <header className="detail-header"><div><h1 id="detail-title">{detail.game.nameZh}</h1><p>{detail.game.nameEn} · {detail.game.productType}</p></div><div><button className="secondary-button" type="button" onClick={() => void refreshNow()}>立即刷新</button><button className="primary-button" type="button" onClick={() => void save({ enabled: !detail.enabled }, detail.enabled ? "订阅已暂停。" : "订阅已启用。")}>{detail.enabled ? "暂停订阅" : "启用订阅"}</button></div></header>
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <section><h2>地区价格</h2><div className="detail-regions">{detail.regions.map((region) => <article key={region.regionalProductId}><h3>{region.regionCode} · {region.currency}</h3>{region.current ? <p><b>{formatLocalPrice(region.current.amountMinor, region.currency)}</b><small>{formatCnyFen(region.current.cnyFen)} · {region.current.source} · {region.current.capturedAt}{region.isStale ? " · 过期" : ""}</small></p> : <p>等待首笔价格</p>}<small>地区历史最低：{region.historicalLow ? `${formatLocalPrice(region.historicalLow.amountMinor, region.currency)}（${formatCnyFen(region.historicalLow.cnyFen)}）` : "暂无"}</small></article>)}</div></section>
    <section className="detail-management">
      <h2>管理订阅</h2>
      <fieldset>
        <legend>补全已启用地区</legend>
        <button className="secondary-button" type="button" disabled={isResolvingMissing} onClick={() => void resolveMissingRegions()}>{isResolvingMissing ? "解析中…" : "补全已启用地区"}</button>
        {missingResolutions.map((resolution) => {
          const presentation = missingRegionPresentation(resolution.status);
          const confirmed = missingConfirmations[resolution.regionCode];
          return <div className="missing-region-option" key={resolution.regionCode}>
            <b>{resolution.regionCode}</b>
            {presentation === "automatic-readonly" && resolution.status === "automatic" ? <small>已自动加入补全草稿：{resolution.candidate.canonicalTitle}</small> : null}
            {presentation === "candidate-list" && resolution.status === "needs-manual-selection" ? <div className="regional-option__candidates">{resolution.candidates.map((candidate) => <button type="button" className={`compact-option${confirmed?.productUrl === candidate.productUrl ? " compact-option--selected" : ""}`} key={candidate.productUrl} onClick={() => acceptMissingCandidate(resolution, candidate, "manual_selection")}>{candidate.canonicalTitle}</button>)}</div> : null}
            {presentation === "link-input" ? <input aria-label={`${resolution.regionCode} 官方链接`} placeholder="粘贴任天堂官方商品链接后按 Enter" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void resolveMissingLink(resolution.regionCode, event.currentTarget.value); } }} /> : null}
            <button type="button" className="text-button" onClick={() => setMissingSkipped((current) => current.includes(resolution.regionCode) ? current.filter((region) => region !== resolution.regionCode) : [...current, resolution.regionCode])}>{confirmed ? "取消该区确认并跳过" : missingSkipped.includes(resolution.regionCode) ? "取消跳过" : "跳过此区"}</button>
            {confirmed ? <small>已确认：{confirmed.canonicalTitle}</small> : null}
          </div>;
        })}
        {missingResolutions.length > 0 ? <button className="primary-button" type="button" disabled={isCompletingMissing || missingResolutions.some((resolution) => !missingConfirmations[resolution.regionCode] && !missingSkipped.includes(resolution.regionCode))} onClick={() => void completeMissingRegions()}>{isCompletingMissing ? "补全中…" : "确认补全"}</button> : null}
      </fieldset>
      <fieldset><legend>监控地区</legend>{detail.regions.map((region) => <label key={region.regionalProductId}><input type="checkbox" checked={selectedIds.has(region.regionalProductId)} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(region.regionalProductId)) next.delete(region.regionalProductId); else next.add(region.regionalProductId); return next; })} />{region.regionCode}（已确认商品）</label>)}<button className="secondary-button" type="button" disabled={selectedIds.size === 0 || [...selectedIds].every((id) => monitoredIds.has(id))} onClick={() => void save({ regionalProductIds: [...selectedIds] }, "监控地区已保存。")}>保存监控地区</button></fieldset>
      <fieldset><legend>目标价（最小货币单位）</legend><label>全局人民币分<input inputMode="numeric" value={globalTarget} onChange={(event) => setGlobalTarget(event.target.value)} placeholder="留空则不设置" /></label>{detail.regions.map((region) => <label key={region.regionCode}>{region.regionCode} 当地最小单位<input inputMode="numeric" value={regionalTargets[region.regionCode] ?? ""} onChange={(event) => setRegionalTargets((current) => ({ ...current, [region.regionCode]: event.target.value }))} placeholder="留空则不设置" /></label>)}<button className="secondary-button" type="button" onClick={() => { const regionTargets = Object.entries(regionalTargets).flatMap(([regionCode, value]) => /^\d+$/.test(value) && Number(value) > 0 ? [{ regionCode, targetAmountMinor: Number(value) }] : []); const globalTargetCnyFen = /^\d+$/.test(globalTarget) && Number(globalTarget) > 0 ? Number(globalTarget) : null; void save({ globalTargetCnyFen, regionTargets }, "目标价已保存。"); }}>保存目标价</button></fieldset>
    </section>
  </section>;
}
