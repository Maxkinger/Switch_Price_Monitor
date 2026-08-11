import { useEffect, useRef, useState, type FormEvent } from "react";

import type { AppSettings, RegionCode, Theme } from "../shared/domain";
import type { ProxyConnectionTestResult } from "../services/proxy-connection-test-service";
import { SettingsApiError, type AiProviderConfigurationInput, type AiProviderConfigurationSummary } from "./settings-api-client";
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
  getAiProviderConfiguration(): Promise<AiProviderConfigurationSummary>;
  saveAiProviderConfiguration(input: AiProviderConfigurationInput): Promise<AiProviderConfigurationSummary>;
  clearAiProviderConfiguration(): Promise<void>;
}

const defaultAiModel = "deepseek-chat";
const officialDeepSeekApiBaseUrl = "https://api.deepseek.com";

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
  const [aiConfiguration, setAiConfiguration] = useState<AiProviderConfigurationSummary | null>(null);
  // Key 只在本组件的短生命周期 state 中存在；不合并到公开 draft、URL 或任何浏览器持久化层。
  const [aiKeyDraft, setAiKeyDraft] = useState("");
  const [aiModelDraft, setAiModelDraft] = useState(defaultAiModel);
  const [aiApiBaseUrlDraft, setAiApiBaseUrlDraft] = useState(officialDeepSeekApiBaseUrl);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  // 初始摘要未完成时只锁定 AI 卡片，避免管理员基于未知配置状态并发保存或清除，同时不妨碍公开偏好继续编辑。
  const [isLoadingAiConfiguration, setIsLoadingAiConfiguration] = useState(true);
  const [isSavingAiConfiguration, setIsSavingAiConfiguration] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  // 摘要版本让失效读取不能倒退已确认状态；初始读取期间另有局部门控，不允许管理员并发保存或清除。
  const aiConfigurationVersion = useRef(0);

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
    // 两个读取彼此无数据依赖，挂载时并行开始以免 AI 摘要拖慢公开偏好表单；Key 不参与任何读取。
    const summaryVersion = aiConfigurationVersion.current;
    void api.getAiProviderConfiguration().then((configuration) => {
      // 保存或清除已产生更新摘要时，旧 GET 即使后到也不能把 UI 回退为历史配置或“未配置”。
      if (!active || summaryVersion !== aiConfigurationVersion.current) return;
      setAiConfiguration(configuration);
      if (configuration.configured) {
        setAiModelDraft(configuration.model ?? defaultAiModel);
        setAiApiBaseUrlDraft(configuration.apiBaseUrl ?? officialDeepSeekApiBaseUrl);
      }
    }).catch((error: unknown) => {
      // 与成功响应同样忽略失效读取的错误，避免旧 401/错误覆盖保存后仍有效的页面状态。
      if (!active || summaryVersion !== aiConfigurationVersion.current) return;
      if (error instanceof SettingsApiError && error.status === 401) {
        setAiKeyDraft("");
        onUnauthorized();
      } else setAiNotice(error instanceof SettingsApiError ? error.message : "AI 配置暂时无法读取，请稍后重试。");
    }).finally(() => {
      // 仅当前摘要读取才能结束局部等待；失效请求不得在保存/清除已推进版本后改变卡片可操作性。
      if (active && summaryVersion === aiConfigurationVersion.current) setIsLoadingAiConfiguration(false);
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

  /** 测试只使用浏览器当前草稿且绝不保存；401 时仍须立即丢弃受保护页面状态。 */
  async function handleProxyTest(): Promise<void> {
    if (!draft) return;
    setIsTestingProxy(true); setProxyTestResult(null);
    try { setProxyTestResult(await api.testProxy(draft.proxy)); }
    catch (error) { if (error instanceof SettingsApiError && error.status === 401) onUnauthorized(); else setNotice(error instanceof SettingsApiError ? error.message : "代理连接测试未完成，请稍后重试。"); }
    finally { setIsTestingProxy(false); }
  }

  /**
   * 保存 AI 配置只占用本卡片，公开偏好仍可独立编辑。成功后立刻丢弃 Key，
   * 使已配置状态只能展示模型和官方地址，下一次替换必须由管理员重新输入完整 Key。
   */
  async function handleAiSave(): Promise<void> {
    if (!aiKeyDraft || isSavingAiConfiguration) return;
    setIsSavingAiConfiguration(true);
    setAiNotice(null);
    try {
      const saved = await api.saveAiProviderConfiguration({ apiKey: aiKeyDraft, model: aiModelDraft, apiBaseUrl: aiApiBaseUrlDraft });
      aiConfigurationVersion.current += 1;
      setAiConfiguration(saved);
      setAiKeyDraft("");
      setAiModelDraft(saved.model ?? defaultAiModel);
      setAiApiBaseUrlDraft(saved.apiBaseUrl ?? officialDeepSeekApiBaseUrl);
      setIsConfirmingClear(false);
      setAiNotice("DeepSeek 配置已保存。");
    } catch (error) {
      if (error instanceof SettingsApiError && error.status === 401) {
        // 会话失效时即使请求失败也不能继续保留管理员刚输入的 Key。
        setAiKeyDraft("");
        onUnauthorized();
      } else setAiNotice(error instanceof SettingsApiError ? error.message : "AI 配置暂时无法保存，请稍后重试。");
    } finally {
      setIsSavingAiConfiguration(false);
    }
  }

  /** 删除经过页面内第二次确认；只删除密文配置，不触碰公开偏好草稿、地区、主题或订阅。 */
  async function handleAiClear(): Promise<void> {
    if (!isConfirmingClear || isSavingAiConfiguration) return;
    setIsSavingAiConfiguration(true);
    setAiNotice(null);
    try {
      await api.clearAiProviderConfiguration();
      aiConfigurationVersion.current += 1;
      setAiConfiguration({ configured: false, model: null, apiBaseUrl: null });
      setAiKeyDraft("");
      setIsConfirmingClear(false);
      setAiNotice("DeepSeek 配置已清除。");
    } catch (error) {
      if (error instanceof SettingsApiError && error.status === 401) {
        setAiKeyDraft("");
        onUnauthorized();
      } else setAiNotice(error instanceof SettingsApiError ? error.message : "AI 配置清除未完成，请稍后重试。");
    } finally {
      setIsSavingAiConfiguration(false);
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

        <fieldset className="settings-card" aria-labelledby="deepseek-configuration-title" aria-busy={isLoadingAiConfiguration} disabled={isSavingAiConfiguration || isLoadingAiConfiguration}>
          <legend id="deepseek-configuration-title">DeepSeek AI 配置</legend>
          <p>{aiConfiguration?.configured ? "DeepSeek 已配置；重新输入 Key 可替换配置。" : "DeepSeek 未配置；中文名称仍可手工填写。"}</p>
          <p className="settings-help">配置仅用于生成待确认的中文名称草稿。API 地址只能使用 DeepSeek 官方域名，保存或替换均须重新输入 Key。</p>
          <div className="settings-grid">
            <label className="settings-field">DeepSeek API Key
              <input type="password" autoComplete="new-password" value={aiKeyDraft} placeholder={aiConfiguration?.configured ? "已保存，重新输入可替换" : "请输入 API Key"} onChange={(event) => setAiKeyDraft(event.target.value)} />
            </label>
            <label className="settings-field">DeepSeek 模型
              <input value={aiModelDraft} maxLength={128} onChange={(event) => setAiModelDraft(event.target.value)} />
            </label>
            <label className="settings-field">DeepSeek API 地址
              <input value={aiApiBaseUrlDraft} onChange={(event) => setAiApiBaseUrlDraft(event.target.value)} />
            </label>
          </div>
          {isLoadingAiConfiguration ? <p className="settings-help" role="status">正在读取 DeepSeek 配置…</p> : null}
          {aiNotice ? <p className="notice" role="status">{aiNotice}</p> : null}
          <div className="settings-actions settings-ai-actions">
            {isConfirmingClear ? <>
              <button className="secondary-button" type="button" onClick={() => setIsConfirmingClear(false)}>取消</button>
              <button className="danger-button" type="button" onClick={() => void handleAiClear()}>确认清除</button>
            </> : <button className="secondary-button" type="button" onClick={() => setIsConfirmingClear(true)}>清除 DeepSeek 配置</button>}
            <button className="primary-button" type="button" disabled={!aiKeyDraft} onClick={() => void handleAiSave()}>{isSavingAiConfiguration ? "保存中…" : "保存 DeepSeek 配置"}</button>
          </div>
        </fieldset>

        <fieldset className="settings-card"><legend>网络代理</legend><p>支持无认证 HTTP、HTTPS 和 SOCKS5。代理失败后会自动尝试直连，直连回退可能暴露 NAS 出口地址。</p><label className="settings-choice"><input type="checkbox" checked={draft.proxy.enabled} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, enabled: event.target.checked } } : current)} />启用网络代理</label><div className="settings-grid"><label className="settings-field">协议<select value={draft.proxy.protocol} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, protocol: event.target.value as SettingsFormState["proxy"]["protocol"] } } : current)}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></label><label className="settings-field">主机<input value={draft.proxy.host} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, host: event.target.value } } : current)} placeholder="127.0.0.1" /></label><label className="settings-field">端口<input type="number" min={1} max={65535} value={draft.proxy.port} onChange={(event) => setDraft((current) => current ? { ...current, proxy: { ...current.proxy, port: Number(event.target.value) } } : current)} /></label></div><p className="settings-help">测试仅使用当前草稿，不会保存或启用代理配置。</p><button type="button" className="secondary-button" disabled={isTestingProxy} onClick={() => void handleProxyTest()}>{isTestingProxy ? "测试中…" : "测试连接"}</button>{proxyTestResult ? <div className="proxy-test-result" role="status"><p>普通 HTTPS：{renderProxyTestStatus(proxyTestResult.http)}</p><p>浏览器 HTTPS：{renderProxyTestStatus(proxyTestResult.browser)}</p></div> : null}</fieldset>

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

/** 页面只显示固定三态，绝不回显代理主机、完整 URL、响应正文或底层错误。 */
function renderProxyTestStatus(status: ProxyConnectionTestResult["http"]): string { return status === "proxy-success" ? "代理连接成功" : status === "direct-fallback-success" ? "代理失败，直连成功" : "代理与直连均失败"; }
