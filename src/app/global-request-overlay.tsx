/**
 * 已认证页面的全局请求遮罩只反映同源 API 是否仍在进行。
 * 它刻意不接收请求 URL、错误或载荷，避免在遮罩中泄露管理员 Cookie、价格来源或服务端诊断内容。
 */
export function GlobalRequestOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div className="global-request-overlay" role="status" aria-live="polite" aria-label="正在同步数据">
      <span className="global-request-overlay__spinner" aria-hidden="true" />
      <span>正在同步数据…</span>
    </div>
  );
}
