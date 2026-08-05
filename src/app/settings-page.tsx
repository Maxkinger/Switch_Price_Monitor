import { useEffect, useState, type FormEvent } from "react";

import type { AppSettings, RegionCode, Theme } from "../shared/domain";
import type { ProxyConnectionTestResult } from "../services/proxy-connection-test-service";
import { SettingsApiError } from "./settings-api-client";
import {
  createSettingsForm,
  setSettingsDefaultRegion,
  toPublicSettingsPatch,
  toggleSettingsRegion,
  type SettingsFormState,
} from "./settings-form";
import { applySettingsRequestFailure } from "./settings-page-state";

/** 设置页仅显示首版五区的公开名称；地区启用与默认区最终仍由 Node 服务的 AppSettings 校验。 */
const regionChoices: ReadonlyArray<{ code: RegionCode; name: string }> = [
  { code: "US", name: "美国区" },
  { code: "JP", name: "日区" },
  { code: "MX", name: "墨西哥区" },
  { code: "BR", name: "巴西区" },
  { code: "HK", name: "香港区" },
];

/** 主题稳定标识与中文展示分离，保存时只把受控标识交给同源设置 API。 */
const themeChoices: ReadonlyArray<{ value: Theme; name: string }> = [
  { value: "warm-card", name: "温暖游戏库" },
  { value: "calm-dark", name: "沉稳深色" },
  { value: "clean-light", name: "清爽工具" },
];

/** 历史保留策略直接对应服务端枚举，避免页面自由拼写导致清理策略被静默忽略。 */
const retentionChoices: ReadonlyArray<{ value: AppSettings["priceHistoryRetention"]; name: string }> = [
  { value: "forever", name: "永久保留" },
  { value: "one-year", name: "仅保留最近一年" },
  { value: "two-years", name: "仅保留最近两年" },
];

/** 页面只需要读取和保存公开偏好；服务端认证、Telegram 和采集来源均不通过该组件传入。 */
interface SettingsPageApi {
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: ReturnType<typeof toPublicSettingsPatch>): Promise<AppSettings>;
  testProxy(settings: SettingsFormState["proxy"]): Promise<ProxyConnectionTestResult>;
}

/**
 * 已认证管理员的公开偏好页。一个表单统一保存地区、展示与保留策略，
 * 让默认搜索区和启用地区在同一个 PATCH 中被服务端原子验证，避免分组自动保存制造短暂无效状态。
 */
export function SettingsPage({ api, onUnauthorized }: { api: SettingsPageApi; onUnauthorized: () => void }) {
  const [draft, setDraft] = useState<SettingsFormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyConnectionTestResult | null>(null);

  useEffect(() => {
    let active = true;
    // 页面只在挂载时读取一次，保存成功以服务端返回的完整值回填；不轮询设置，以免覆盖管理员正在编辑的草稿。
    void api.getSettings().then((settings) => {
      if (active) setDraft(createSettingsForm(settings));
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof SettingsApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof SettingsApiError ? error.message : "设置暂时无法读取，请稍后重试。");
    });
    return () => { active = false; };
  }, [api, onUnauthorized]);

  /** 全量 PATCH 的异步保存边界：保存中禁止重复请求，422 保留草稿，401 立即交给认证外壳清理。 */
  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    setIsSaving(true);
    setNotice(null);
    try {
      const saved = await api.saveSettings(toPublicSettingsPatch(draft));
      setDraft(createSettingsForm(saved));
      setNotice("设置已保存。");
    } catch (error) {
      if (error instanceof SettingsApiError) {
        const next = applySettingsRequestFailure(draft, error);
        if (next.kind === "unauthorized") onUnauthorized();
        else setNotice(next.error);
      } else {
        setNotice("设置暂时无法保存，请稍后重试。");
      }
    } finally {
      setIsSaving(false);
    }
  }

  /** 测试只使用当前浏览器草稿且绝不保存；401 仍要立即清空受保护页面状态。 */
  async function handleProxyTest(): Promise<void> {
    if (!draft) return;
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      setProxyTestResult(await api.testProxy(draft.proxy));
    } catch (error) {
      if (error instanceof SettingsApiError && error.status === 401) onUnauthorized();
      else setNotice(error instanceof SettingsApiError ? error.message : "代理连接测试未完成，请稍后重试。");
    } finally {
      setIsTestingProxy(false);
    }
  }

  if (!draft) return <p className="page-loading">正在读取设置…</p>;

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <header className="settings-page__header">
        <p className="eyebrow">个人偏好</p>
        <h1 id="settings-title">设置</h1>
        <p>这些设置只影响后续搜索、展示和定时任务，不会改写已有订阅的地区商品。</p>
      </header>

      <form className="settings-form" onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className="settings-card">
          <legend>地区与搜索</legend>
          <p>启用地区决定后续新增商品可选择的监控范围；默认搜索区只影响新建订阅。</p>
          <div className="settings-region-grid">
            {regionChoices.map((region) => {
              const checked = draft.enabledRegions.includes(region.code);
              const isFinalRegion = checked && draft.enabledRegions.length === 1;
              return (
                <label key={region.code} className="settings-choice">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isFinalRegion}
                    onChange={() => setDraft((current) => current ? toggleSettingsRegion(current, region.code) : current)}
                  />
                  {region.name}
                </label>
              );
            })}
          </div>
          <label className="settings-field">
            默认搜索区
            <select
              value={draft.defaultSearchRegion}
              onChange={(event) => setDraft((current) => current ? setSettingsDefaultRegion(current, event.target.value as RegionCode) : current)}
            >
              {regionChoices.filter((region) => draft.enabledRegions.includes(region.code)).map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}
            </select>
          </label>
        </fieldset>

        <fieldset className="settings-card">
          <legend>网络代理</legend>
          <p>支持无认证 HTTP、HTTPS 和 SOCKS5。代理失败后会自动尝试直连，直连回退可能暴露 NAS 出口地址。</p>
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={draft.proxy.enabled}
              onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, enabled: event.target.checked } } : current)}
            />
            启用网络代理
          </label>
          <div className="settings-grid">
            <label className="settings-field">协议
              <select value={draft.proxy.protocol} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, protocol: event.target.value as SettingsFormState["proxy"]["protocol"] } } : current)}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </label>
            <label className="settings-field">主机
              <input value={draft.proxy.host} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, host: event.target.value } } : current)} placeholder="127.0.0.1" />
            </label>
            <label className="settings-field">端口
              <input type="number" min={1} max={65535} value={draft.proxy.port} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, port: Number(event.target.value) } } : current)} />
            </label>
          </div>
          <p className="settings-help">测试仅使用当前草稿，不会保存或启用代理配置。</p>
          <button type="button" className="secondary-button" disabled={isTestingProxy} onClick={() => void handleProxyTest()}>{isTestingProxy ? "测试中…" : "测试连接"}</button>
          {proxyTestResult ? <div className="proxy-test-result" role="status">
            <p>普通 HTTPS：{renderProxyTestStatus(proxyTestResult.http)}</p>
            <p>浏览器 HTTPS：{renderProxyTestStatus(proxyTestResult.browser)}</p>
          </div> : null}
        </fieldset>

        <fieldset className="settings-card">
          <legend>展示与日报</legend>
          <div className="settings-grid">
            <label className="settings-field">视觉主题
              <select value={draft.theme} onChange={(event) => setDraft((current) => current ? { ...current, theme: event.target.value as Theme } : current)}>
                {themeChoices.map((theme) => <option key={theme.value} value={theme.value}>{theme.name}</option>)}
              </select>
            </label>
            <label className="settings-field">时区
              <input value={draft.timezone} onChange={(event) => setDraft((current) => current ? { ...current, timezone: event.target.value } : current)} placeholder="例如：Asia/Shanghai" />
            </label>
            <label className="settings-field">日报时间
              <input type="time" value={draft.dailyReportTime} onChange={(event) => setDraft((current) => current ? { ...current, dailyReportTime: event.target.value } : current)} />
            </label>
            <label className="settings-field">美国税务州
              <input value={draft.taxState} maxLength={2} onChange={(event) => setDraft((current) => current ? { ...current, taxState: event.target.value.toUpperCase() } : current)} placeholder="OR" />
            </label>
          </div>
          <small>主题偏好会保存；全局视觉切换将在后续界面任务中接入。</small>
        </fieldset>

        <fieldset className="settings-card">
          <legend>数据保留</legend>
          <p>保留策略从下一次定时维护开始生效，不会在本页立即删除历史价格。</p>
          <div className="settings-retention-list">
            {retentionChoices.map((choice) => (
              <label className="settings-choice" key={choice.value}>
                <input
                  type="radio"
                  name="price-history-retention"
                  checked={draft.priceHistoryRetention === choice.value}
                  onChange={() => setDraft((current) => current ? { ...current, priceHistoryRetention: choice.value } : current)}
                />
                {choice.name}
              </label>
            ))}
          </div>
        </fieldset>

        {notice ? <p className="notice" role="status">{notice}</p> : null}
        <div className="settings-actions"><button className="primary-button" type="submit" disabled={isSaving}>{isSaving ? "保存中…" : "保存设置"}</button></div>
      </form>
    </section>
  );
}

/** 将服务端三态映射为固定中文文案；页面不能回显代理主机、完整 URL、响应正文或底层异常。 */
function renderProxyTestStatus(status: ProxyConnectionTestResult["http"]): string {
  return status === "proxy-success" ? "代理连接成功" : status === "direct-fallback-success" ? "代理失败，直连成功" : "代理与直连均失败";
}
